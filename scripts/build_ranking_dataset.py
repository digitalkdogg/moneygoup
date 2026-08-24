#!/usr/bin/env python3
"""
Build the cross-sectional ranking dataset (Step 1 of the deepmoney_sync
ranker revamp).

For each snapshot date D over a trailing window, for every ticker in the
`stocks` universe, compute a GREEN-only feature vector (OHLCV-derived
technicals, macro time-series, calendar, World Bank annuals) using only
data available as-of D, and a 20-trading-day forward return label.

Feature formulas mirror scripts/predict_weighted_analysis.py
(`_calculate_features_internal` + `_add_macro_features`). RED features
(live fundamentals, news sentiment, analyst revisions, pre/post-market,
peer RS, institution ownership, earnings windows) are intentionally
omitted from v1 because they cannot be reconstructed as-of D without
leakage.

Source: yfinance historical pulls. The `predict_weighted_analysis.py`
hot-path constraint against importing yfinance does NOT apply here —
this is an offline data-builder, not the inference path.

Output: rows in `ranking_training_snapshots` (created idempotently via
CREATE TABLE IF NOT EXISTS) and optionally a CSV via --csv.

USAGE:
  python scripts/build_ranking_dataset.py
      [--start YYYY-MM-DD] [--end YYYY-MM-DD]
      [--cadence weekly|monthly] [--horizon 20]
      [--limit N] [--tickers AAPL,MSFT] [--dry-run] [--csv path]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date as date_t
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

try:
    import yfinance as yf
except ImportError:
    print(
        "ERROR: yfinance is not installed.\n"
        "  Install with:  pip install yfinance\n"
        "  (added to requirements.txt for offline dataset building only)",
        file=sys.stderr,
    )
    sys.exit(1)

import mysql.connector
from dotenv import load_dotenv

from ranker_features import (
    FEATURE_COLUMNS,
    FEATURE_SET_VERSION,
    MIN_HISTORY_ROWS,
    compute_features,
)


# ─── Config ─────────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env.local")

DEFAULT_HORIZON = 20
DEFAULT_CADENCE = "weekly"
DEFAULT_HISTORY_MONTHS = 24
SECTOR_CACHE_PATH = PROJECT_ROOT / "scripts" / "prediction_cache" / "sector_map.json"

# Sector → ETF mapping (mirrors src/app/api/stock_data/[ticker]/data/route.ts:55)
SECTOR_ETF = {
    "Technology": "XLK",
    "Healthcare": "XLV",
    "Financials": "XLF",
    "Financial Services": "XLF",
    "Consumer Cyclical": "XLY",
    "Consumer Defensive": "XLP",
    "Industrials": "XLI",
    "Energy": "XLE",
    "Utilities": "XLU",
    "Real Estate": "XLRE",
    "Basic Materials": "XLB",
    "Materials": "XLB",
    "Communication Services": "XLC",
}
SECTOR_ETFS_UNIQUE = sorted(set(SECTOR_ETF.values()))

MACRO_SYMBOL_MAP = {
    "vix": "^VIX",
    "tnx": "^TNX",
    "irx": "^IRX",
    "hyg": "HYG",
    "lqd": "LQD",
    "dxy": "DX-Y.NYB",
    "spy": "SPY",
    "wti": "CL=F",
    "copper": "HG=F",
    "wheat": "ZW=F",
}

DDL = """
CREATE TABLE IF NOT EXISTS ranking_training_snapshots (
    id BIGINT NOT NULL AUTO_INCREMENT,
    snapshot_date DATE NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    stock_id INT NULL,
    horizon_days INT NOT NULL,
    forward_return DECIMAL(10,6) NULL,
    forward_return_rank_pct DECIMAL(6,4) NULL,
    features_json JSON NOT NULL,
    feature_set_version VARCHAR(20) NOT NULL DEFAULT 'green_v1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_snap_ticker_horizon (snapshot_date, ticker, horizon_days, feature_set_version),
    INDEX idx_snapshot_date (snapshot_date),
    INDEX idx_ticker (ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""


# ─── DB ─────────────────────────────────────────────────────────────────────
def _clean(s: Optional[str]) -> str:
    return (s or "").strip().strip('"').strip("'")


def db_conn() -> mysql.connector.MySQLConnection:
    return mysql.connector.connect(
        host=_clean(os.environ.get("DB_HOST")),
        port=int(_clean(os.environ.get("DB_PORT")) or 3306),
        user=_clean(os.environ.get("DB_USER")),
        password=_clean(os.environ.get("DB_PASSWORD")),
        database=_clean(os.environ.get("DB_DATABASE")),
    )


def fetch_world_bank_indicators_by_year(conn) -> Dict[int, Dict[str, float]]:
    """Returns {year: {gdpGrowth, inflation, consumptionGrowth}} for USA."""
    cur = conn.cursor(dictionary=True)
    cur.execute(
        "SELECT indicator_code, year, value FROM world_bank_macro_data WHERE country_code = 'USA'"
    )
    rows = cur.fetchall()
    cur.close()

    INDICATOR_MAP = {
        "NY.GDP.MKTP.KD.ZG": "gdpGrowth",
        "FP.CPI.TOTL.ZG": "inflation",
        "NE.CON.PRVT.KD.ZG": "consumptionGrowth",
    }
    out: Dict[int, Dict[str, float]] = {}
    for r in rows:
        key = INDICATOR_MAP.get(r["indicator_code"])
        if not key:
            continue
        y = int(r["year"])
        out.setdefault(y, {})[key] = float(r["value"]) if r["value"] is not None else None
    return out


def fetch_universe(conn) -> List[Tuple[Optional[int], str]]:
    cur = conn.cursor()
    cur.execute("SELECT id, symbol FROM stocks ORDER BY symbol")
    rows = cur.fetchall()
    cur.close()
    return rows


def resolve_sectors(tickers: List[str]) -> Dict[str, str]:
    """One-time per-ticker sector lookup via yf.Ticker.info, cached on disk."""
    cache: Dict[str, str] = {}
    if SECTOR_CACHE_PATH.exists():
        try:
            cache = json.loads(SECTOR_CACHE_PATH.read_text())
        except Exception:
            cache = {}

    missing = [t for t in tickers if t not in cache]
    SECTOR_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    for i, t in enumerate(missing, 1):
        try:
            info = yf.Ticker(t).info
            sector = info.get("sector") or "_default"
        except Exception:
            sector = "_default"
        cache[t] = sector
        if i % 25 == 0:
            print(f"  sectors: {i}/{len(missing)} resolved", file=sys.stderr)
            SECTOR_CACHE_PATH.write_text(json.dumps(cache, indent=2))
    SECTOR_CACHE_PATH.write_text(json.dumps(cache, indent=2))
    return cache


# ─── Data fetching ──────────────────────────────────────────────────────────
def fetch_history_batch(symbols: List[str], start: str, end: str) -> Dict[str, pd.DataFrame]:
    """Bulk-pull OHLCV via yf.download; return {symbol: df with cols open/high/low/close/volume}."""
    if not symbols:
        return {}
    print(f"  yf.download {len(symbols)} symbols {start} → {end}", file=sys.stderr)
    df = yf.download(
        tickers=symbols,
        start=start,
        end=end,
        group_by="ticker",
        auto_adjust=True,
        progress=False,
        threads=True,
    )

    out: Dict[str, pd.DataFrame] = {}
    if len(symbols) == 1:
        d = df.copy()
        d.columns = [c.lower() if isinstance(c, str) else c for c in d.columns]
        if not d.empty:
            out[symbols[0]] = d.dropna(how="all")
        return out

    level0 = set(df.columns.get_level_values(0))
    for sym in symbols:
        if sym not in level0:
            continue
        sub = df[sym].copy()
        sub.columns = [c.lower() for c in sub.columns]
        sub = sub.dropna(how="all")
        if not sub.empty:
            out[sym] = sub
    return out


# Feature computation lives in scripts/ranker_features.py — see import above.
# Keeping a single source of truth prevents train/inference drift.




def forward_return(ohlcv: pd.DataFrame, snap: pd.Timestamp, horizon: int) -> Optional[float]:
    base = ohlcv.loc[ohlcv.index <= snap]
    if base.empty:
        return None
    fwd = ohlcv.loc[ohlcv.index > snap].head(horizon)
    if len(fwd) < horizon:
        return None
    p0 = float(base["close"].iloc[-1])
    p1 = float(fwd["close"].iloc[-1])
    if not np.isfinite(p0) or p0 <= 0 or not np.isfinite(p1):
        return None
    return p1 / p0 - 1.0


def snapshot_dates(start: pd.Timestamp, end: pd.Timestamp, cadence: str, calendar: pd.DatetimeIndex) -> List[pd.Timestamp]:
    cal = calendar[(calendar >= start) & (calendar <= end)]
    if cadence == "weekly":
        df = pd.DataFrame({"d": cal})
        df["w"] = df["d"].dt.to_period("W")
        return sorted(df.groupby("w")["d"].max().tolist())
    if cadence == "monthly":
        df = pd.DataFrame({"d": cal})
        df["m"] = df["d"].dt.to_period("M")
        return sorted(df.groupby("m")["d"].max().tolist())
    return list(cal)


# ─── Persistence ────────────────────────────────────────────────────────────
def _json_safe(v):
    if v is None:
        return None
    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
        return None
    return float(v)


def insert_rows(conn, rows: List[Tuple]) -> int:
    if not rows:
        return 0
    cur = conn.cursor()
    sql = """
        INSERT INTO ranking_training_snapshots
            (snapshot_date, ticker, stock_id, horizon_days, forward_return,
             forward_return_rank_pct, features_json, feature_set_version)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            stock_id = VALUES(stock_id),
            forward_return = VALUES(forward_return),
            forward_return_rank_pct = VALUES(forward_return_rank_pct),
            features_json = VALUES(features_json)
    """
    cur.executemany(sql, rows)
    conn.commit()
    n = cur.rowcount
    cur.close()
    return n


# ─── Main ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", help="Snapshot window start (YYYY-MM-DD). Default: end - 24mo.")
    ap.add_argument("--end", help="Snapshot window end (YYYY-MM-DD). Default: today - ~3w buffer.")
    ap.add_argument("--cadence", default=DEFAULT_CADENCE, choices=["weekly", "monthly"])
    ap.add_argument("--horizon", type=int, default=DEFAULT_HORIZON)
    ap.add_argument("--limit", type=int, default=0, help="Limit tickers (smoke test).")
    ap.add_argument("--tickers", help="Comma-separated ticker subset (overrides DB universe).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--csv", help="Optional CSV output path.")
    args = ap.parse_args()

    conn = db_conn()

    # Ensure table exists
    cur = conn.cursor()
    cur.execute(DDL)
    conn.commit()
    cur.close()

    # Universe
    if args.tickers:
        universe: List[Tuple[Optional[int], str]] = [
            (None, t.strip().upper()) for t in args.tickers.split(",") if t.strip()
        ]
    else:
        universe = fetch_universe(conn)
    if args.limit:
        universe = universe[: args.limit]
    print(f"[universe] {len(universe)} tickers", file=sys.stderr)

    tickers = [u[1] for u in universe]
    sector_map = resolve_sectors(tickers)

    # Window
    end_dt = pd.Timestamp(args.end) if args.end else (pd.Timestamp.today().normalize() - pd.Timedelta(days=int(args.horizon * 1.6) + 7))
    start_dt = pd.Timestamp(args.start) if args.start else end_dt - pd.DateOffset(months=DEFAULT_HISTORY_MONTHS)

    # Pad fetch window for 252-day lookback + horizon forward
    fetch_start = (start_dt - pd.DateOffset(days=420)).strftime("%Y-%m-%d")
    fetch_end = (end_dt + pd.DateOffset(days=int(args.horizon * 1.8) + 14)).strftime("%Y-%m-%d")

    # Macro + sector ETFs in one batch
    bulk_syms = sorted(set(list(MACRO_SYMBOL_MAP.values()) + SECTOR_ETFS_UNIQUE))
    macro_raw = fetch_history_batch(bulk_syms, fetch_start, fetch_end)
    macro_series: Dict[str, Optional[pd.Series]] = {
        key: macro_raw.get(sym, pd.DataFrame()).get("close") for key, sym in MACRO_SYMBOL_MAP.items()
    }
    sector_etf_close: Dict[str, Optional[pd.Series]] = {
        etf: macro_raw.get(etf, pd.DataFrame()).get("close") for etf in SECTOR_ETFS_UNIQUE
    }

    # World Bank lookup
    wb_by_year = fetch_world_bank_indicators_by_year(conn)

    # green_v2: load historical fundamentals + sector medians in bulk. Both
    # are optional — feature builder falls back to None-safe defaults when a
    # (ticker, snap) pair has no matching row.
    print("[fundamentals] loading yahoo_historical_fundamentals...", file=sys.stderr)
    fund_cur = conn.cursor(dictionary=True)
    # Item 4 (fundamentals anomaly triage): exclude rows the LLM flagged as
    # likely data errors. NULL = not yet triaged; keep those (pre-triage
    # backfill or triage disabled). Only drop rows explicitly marked = 1.
    fund_cur.execute("""
        SELECT symbol, period_end_date, free_cash_flow, operating_cash_flow,
               total_cash, total_debt, total_revenue, ebitda, eps,
               price_at_period_end, market_cap_at_period_end
        FROM yahoo_historical_fundamentals
        WHERE flagged_anomaly IS NULL OR flagged_anomaly = 0
    """)
    fund_rows = fund_cur.fetchall()
    fund_cur.close()
    # symbol → list of (period_end_date, row) sorted ascending
    fundamentals_map: Dict[str, List[Tuple[pd.Timestamp, Dict]]] = {}
    for r in fund_rows:
        sym = r['symbol']
        pd_dt = pd.Timestamp(r['period_end_date'])
        fundamentals_map.setdefault(sym, []).append((pd_dt, r))
    for sym in fundamentals_map:
        fundamentals_map[sym].sort(key=lambda x: x[0])
    print(f"  {len(fund_rows):,} fundamentals rows across {len(fundamentals_map):,} tickers", file=sys.stderr)

    print("[fundamentals] loading sector_median_history...", file=sys.stderr)
    sec_cur = conn.cursor(dictionary=True)
    sec_cur.execute("""
        SELECT sector, period_end_date, pe_median, ps_median,
               ev_ebitda_median, ev_revenue_median, fcf_yield_median
        FROM sector_median_history
    """)
    sec_rows = sec_cur.fetchall()
    sec_cur.close()
    sector_medians_map: Dict[str, List[Tuple[pd.Timestamp, Dict]]] = {}
    for r in sec_rows:
        sec = r['sector']
        pd_dt = pd.Timestamp(r['period_end_date'])
        sector_medians_map.setdefault(sec, []).append((pd_dt, r))
    for sec in sector_medians_map:
        sector_medians_map[sec].sort(key=lambda x: x[0])
    print(f"  {len(sec_rows):,} sector-median rows across {len(sector_medians_map):,} sectors", file=sys.stderr)

    def nearest_before(series: List[Tuple[pd.Timestamp, Dict]], snap: pd.Timestamp) -> Optional[Dict]:
        """Bisect the sorted series for the row with the largest date ≤ snap."""
        if not series:
            return None
        # Simple linear walk — series is short (≤ ~40 quarters per ticker).
        best = None
        for dt, row in series:
            if dt <= snap:
                best = row
            else:
                break
        return best

    # Trading calendar — use SPY index as the reference business calendar
    spy = macro_raw.get("SPY")
    if spy is None or spy.empty:
        print("ERROR: SPY data missing; cannot establish trading calendar.", file=sys.stderr)
        return 2
    calendar = pd.DatetimeIndex(spy.index)
    snaps = snapshot_dates(start_dt, end_dt, args.cadence, calendar)
    if not snaps:
        print("ERROR: No snapshot dates in window.", file=sys.stderr)
        return 2
    print(
        f"[snapshots] {len(snaps)} dates ({args.cadence}) {snaps[0].date()} → {snaps[-1].date()}",
        file=sys.stderr,
    )

    # Process tickers in chunks (yfinance batches well at 50)
    BATCH = 50
    total_inserted = 0
    skipped_no_data = 0
    csv_rows: List[dict] = []

    for ci in range(0, len(universe), BATCH):
        chunk = universe[ci : ci + BATCH]
        chunk_syms = [u[1] for u in chunk]
        ohlcv_map = fetch_history_batch(chunk_syms, fetch_start, fetch_end)

        # Buffer per-snapshot so we can compute cross-sectional rank_pct
        per_snap: Dict[pd.Timestamp, List[Tuple]] = {}
        for stock_id, sym in chunk:
            ohlcv = ohlcv_map.get(sym)
            if ohlcv is None or ohlcv.empty:
                skipped_no_data += 1
                continue
            sector = sector_map.get(sym, "_default")
            etf_sym = SECTOR_ETF.get(sector, "SPY")
            sec_close = sector_etf_close.get(etf_sym)
            if sec_close is None or sec_close.empty:
                sec_close = macro_series.get("spy")

            for snap in snaps:
                fwd = forward_return(ohlcv, snap, args.horizon)
                if fwd is None or not np.isfinite(fwd):
                    continue
                wb_y = wb_by_year.get(snap.year, {}) or wb_by_year.get(snap.year - 1, {})
                # green_v2: nearest-before fundamentals + sector medians for this snap
                fund_row = nearest_before(fundamentals_map.get(sym, []), snap)
                sec_row  = nearest_before(sector_medians_map.get(sector, []), snap)
                feats = compute_features(snap, ohlcv, sec_close, macro_series, wb_y,
                                          fundamentals=fund_row, sector_medians=sec_row)
                if feats is None:
                    continue
                per_snap.setdefault(snap, []).append((stock_id, sym, snap, feats, fwd))

        # Cross-sectional rank within each snapshot date (over this chunk only;
        # final rank across all tickers is recomputed once at the end below)
        rows: List[Tuple] = []
        for snap, items in per_snap.items():
            for stock_id, sym, sd, feats, fwd in items:
                rows.append(
                    (
                        sd.date(),
                        sym,
                        stock_id,
                        args.horizon,
                        float(fwd),
                        None,  # rank_pct filled in second pass after all chunks
                        json.dumps({k: _json_safe(v) for k, v in feats.items()}),
                        FEATURE_SET_VERSION,
                    )
                )
                if args.csv:
                    csv_rows.append({"snapshot_date": sd.date().isoformat(), "ticker": sym, "forward_return": fwd, **feats})

        if rows and not args.dry_run:
            total_inserted += insert_rows(conn, rows)
        print(
            f"[chunk {ci//BATCH + 1}/{(len(universe)-1)//BATCH + 1}] {len(chunk_syms)} tickers → "
            f"{len(rows)} rows (inserted_total={total_inserted}, no_data={skipped_no_data})",
            file=sys.stderr,
        )

    # Second pass: recompute rank_pct across the full universe per snapshot date
    if not args.dry_run:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT snapshot_date, COUNT(*) FROM ranking_training_snapshots
            WHERE feature_set_version = %s AND horizon_days = %s
              AND snapshot_date BETWEEN %s AND %s
            GROUP BY snapshot_date
            """,
            (FEATURE_SET_VERSION, args.horizon, snaps[0].date(), snaps[-1].date()),
        )
        cur.fetchall()
        cur.close()

        # MySQL-side ranking via window function (MySQL 8+)
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE ranking_training_snapshots t
            JOIN (
                SELECT id,
                       PERCENT_RANK() OVER (PARTITION BY snapshot_date ORDER BY forward_return) AS pr
                FROM ranking_training_snapshots
                WHERE feature_set_version = %s
                  AND horizon_days = %s
                  AND snapshot_date BETWEEN %s AND %s
            ) r ON r.id = t.id
            SET t.forward_return_rank_pct = ROUND(r.pr, 4)
            """,
            (FEATURE_SET_VERSION, args.horizon, snaps[0].date(), snaps[-1].date()),
        )
        conn.commit()
        cur.close()

    if args.csv and csv_rows:
        out_df = pd.DataFrame(csv_rows)
        out_df.to_csv(args.csv, index=False)
        print(f"[csv] wrote {len(out_df)} rows → {args.csv}", file=sys.stderr)

    conn.close()
    print(f"DONE inserted={total_inserted} skipped_no_data={skipped_no_data}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
