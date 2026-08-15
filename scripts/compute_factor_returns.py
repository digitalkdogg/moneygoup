#!/usr/bin/env python3
"""
compute_factor_returns.py — Multi-factor exposure pipeline.

Quintile-buckets the tracked universe by fundamental factors (value, size,
quality), forms long-top/short-bottom synthetic factor return series, then
regresses each stock's trailing-60d returns against them to get per-stock
factor betas and idiosyncratic residual.

Results stored in factor_exposures table (created if not exists).

Usage:
  python3 scripts/compute_factor_returns.py
  python3 scripts/compute_factor_returns.py --as-of-date 2026-07-01
  python3 scripts/compute_factor_returns.py --tickers AAPL,MSFT,GOOG
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import yfinance as yf
except ImportError:
    print(
        "ERROR: yfinance is not installed.\n"
        "  Install with:  pip install yfinance",
        file=sys.stderr,
    )
    sys.exit(1)

import mysql.connector
from dotenv import load_dotenv

# ── Paths & env ───────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent

if (PROJECT_ROOT / ".env.production").exists():
    load_dotenv(PROJECT_ROOT / ".env.production")
load_dotenv(PROJECT_ROOT / ".env.local", override=True)

DB_HOST     = os.getenv("DB_HOST", "localhost")
DB_USER     = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_DATABASE = os.getenv("DB_DATABASE")
DB_PORT     = int(os.getenv("DB_PORT", 3306))

QUINTILE_N  = 5  # number of quintile buckets


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_db() -> mysql.connector.MySQLConnection:
    return mysql.connector.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_DATABASE,
        port=DB_PORT,
    )


DDL_FACTOR_EXPOSURES = """
CREATE TABLE IF NOT EXISTS factor_exposures (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    ticker           VARCHAR(10)    NOT NULL,
    as_of_date       DATE           NOT NULL,
    beta_value       DECIMAL(8,4),
    beta_size        DECIMAL(8,4),
    beta_quality     DECIMAL(8,4),
    idiosyncratic_60d DECIMAL(8,4),
    n_obs            INT,
    r_squared        DECIMAL(6,4),
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_ticker_date (ticker, as_of_date),
    INDEX idx_as_of_date (as_of_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""


def ensure_table(conn: mysql.connector.MySQLConnection) -> None:
    cur = conn.cursor()
    cur.execute(DDL_FACTOR_EXPOSURES)
    conn.commit()
    cur.close()


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Compute per-stock factor betas (value, size, quality) and write to factor_exposures.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--as-of-date",
        default=str(date.today()),
        metavar="YYYY-MM-DD",
        help="Date to compute exposures as of (default: today)",
    )
    p.add_argument(
        "--tickers",
        default="all",
        help="Comma-separated tickers or 'all' (default: all)",
    )
    p.add_argument(
        "--lookback-days",
        type=int,
        default=90,
        help="Days of price history to fetch (default: 90)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't write results to DB",
    )
    return p.parse_args()


# ── Universe ──────────────────────────────────────────────────────────────────

def get_universe(conn: mysql.connector.MySQLConnection, tickers_arg: str) -> list[dict]:
    """
    Pull symbol, sector, pe_ratio, pb_ratio, market_cap from stocks table.
    Filter to requested tickers when tickers_arg != 'all'.
    """
    cur = conn.cursor(dictionary=True)
    if tickers_arg.strip().lower() == "all":
        cur.execute(
            """
            SELECT symbol, sector, pe_ratio, pb_ratio, market_cap
            FROM stocks
            WHERE symbol IS NOT NULL AND symbol != ''
            ORDER BY symbol
            """
        )
    else:
        symbols = [t.strip().upper() for t in tickers_arg.split(",") if t.strip()]
        placeholders = ", ".join(["%s"] * len(symbols))
        cur.execute(
            f"""
            SELECT symbol, sector, pe_ratio, pb_ratio, market_cap
            FROM stocks
            WHERE symbol IN ({placeholders})
            ORDER BY symbol
            """,
            symbols,
        )
    rows = cur.fetchall()
    cur.close()
    return rows


# ── Price fetch ───────────────────────────────────────────────────────────────

def fetch_prices(
    symbols: list[str],
    start_date: date,
    end_date: date,
) -> pd.DataFrame:
    """
    Download adjusted close prices for all symbols at once via yfinance.
    Returns DataFrame with dates as index, tickers as columns.
    Missing tickers are silently dropped (yfinance behaviour).
    """
    if not symbols:
        return pd.DataFrame()

    start_str = str(start_date)
    # yfinance end date is exclusive, so add one day
    end_str   = str(end_date + timedelta(days=1))

    print(f"[compute_factor_returns] Fetching prices for {len(symbols)} symbols "
          f"({start_str} → {end_str})...")
    try:
        raw = yf.download(
            symbols,
            start=start_str,
            end=end_str,
            auto_adjust=True,
            progress=False,
            threads=True,
        )
        if isinstance(raw.columns, pd.MultiIndex):
            prices = raw["Close"]
        else:
            # Single ticker: raw is already a Close series with level "Close" etc.
            prices = raw[["Close"]] if "Close" in raw.columns else raw
            if len(symbols) == 1:
                prices = prices.rename(columns={"Close": symbols[0]})
    except Exception as exc:
        print(f"[compute_factor_returns] yfinance error: {exc}", file=sys.stderr)
        return pd.DataFrame()

    # Drop entirely-null columns
    prices = prices.dropna(axis=1, how="all")
    print(f"[compute_factor_returns] Got prices for {prices.shape[1]} tickers, "
          f"{prices.shape[0]} trading days")
    return prices


# ── Factor construction ───────────────────────────────────────────────────────

def _quintile_spread_daily(
    prices_df: pd.DataFrame,
    sorted_tickers_long: list[str],
    sorted_tickers_short: list[str],
) -> pd.Series:
    """
    Daily return spread: avg(top-quintile daily returns) - avg(bottom-quintile daily returns).
    Both groups are filtered to tickers present in prices_df.
    """
    long_cols  = [t for t in sorted_tickers_long  if t in prices_df.columns]
    short_cols = [t for t in sorted_tickers_short if t in prices_df.columns]

    if not long_cols or not short_cols:
        return pd.Series(dtype=float)

    daily_ret = prices_df.pct_change()

    long_ret  = daily_ret[long_cols].mean(axis=1)
    short_ret = daily_ret[short_cols].mean(axis=1)
    return (long_ret - short_ret).rename("factor")


def compute_factor_returns(
    prices_df: pd.DataFrame,
    fundamentals_df: pd.DataFrame,
    as_of_date: date,
) -> pd.DataFrame:
    """
    Build quintile long-minus-short factor return series.

    Value   : sort pe_ratio ascending  → long cheap (low PE), short expensive
    Size    : sort market_cap ascending → long small-cap, short large-cap
    Quality : sort pb_ratio descending → long high-PB (growth/quality), short low-PB

    Returns DataFrame columns [value_factor, size_factor, quality_factor], index = dates.
    """
    avail = [c for c in fundamentals_df["symbol"] if c in prices_df.columns]
    fund  = fundamentals_df[fundamentals_df["symbol"].isin(avail)].copy()

    n = len(fund)
    if n < QUINTILE_N * 2:
        print(f"[compute_factor_returns] Too few tickers ({n}) for quintile bucketing",
              file=sys.stderr)
        return pd.DataFrame()

    q_size = max(1, n // QUINTILE_N)

    # Value: low PE = cheap = long top
    value_sorted = fund.dropna(subset=["pe_ratio"]).sort_values("pe_ratio")
    value_long   = list(value_sorted["symbol"].iloc[:q_size])
    value_short  = list(value_sorted["symbol"].iloc[-q_size:])

    # Size: low market_cap = small = long top
    size_sorted  = fund.dropna(subset=["market_cap"]).sort_values("market_cap")
    size_long    = list(size_sorted["symbol"].iloc[:q_size])
    size_short   = list(size_sorted["symbol"].iloc[-q_size:])

    # Quality: high PB = quality = long top
    qual_sorted  = fund.dropna(subset=["pb_ratio"]).sort_values("pb_ratio", ascending=False)
    qual_long    = list(qual_sorted["symbol"].iloc[:q_size])
    qual_short   = list(qual_sorted["symbol"].iloc[-q_size:])

    value_series   = _quintile_spread_daily(prices_df, value_long,  value_short)
    size_series    = _quintile_spread_daily(prices_df, size_long,   size_short)
    quality_series = _quintile_spread_daily(prices_df, qual_long,   qual_short)

    factor_df = pd.DataFrame({
        "value_factor":   value_series,
        "size_factor":    size_series,
        "quality_factor": quality_series,
    }).dropna()

    return factor_df


# ── OLS exposure ──────────────────────────────────────────────────────────────

def compute_exposures(
    ticker: str,
    ticker_returns: pd.Series,
    factor_returns_df: pd.DataFrame,
) -> dict | None:
    """
    OLS: ticker_returns ~ value_factor + size_factor + quality_factor
    Returns dict with beta_value, beta_size, beta_quality, idiosyncratic_60d,
    r_squared, n_obs. Returns None if not enough data.
    """
    # Align on common dates, use last 60 trading observations
    common = ticker_returns.index.intersection(factor_returns_df.index)
    if len(common) < 10:
        return None

    y = ticker_returns.loc[common].values
    X_raw = factor_returns_df.loc[common][["value_factor", "size_factor", "quality_factor"]].values

    # Add intercept column
    X = np.column_stack([np.ones(len(y)), X_raw])

    # Trim to last 60 obs
    if len(y) > 60:
        y = y[-60:]
        X = X[-60:]

    n_obs = len(y)
    if n_obs < 5:
        return None

    try:
        coeffs, residuals, rank, _ = np.linalg.lstsq(X, y, rcond=None)
    except np.linalg.LinAlgError:
        return None

    y_pred = X @ coeffs
    resid  = y - y_pred
    ss_res = float(np.sum(resid ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r_sq   = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    return {
        "beta_value":         float(coeffs[1]),
        "beta_size":          float(coeffs[2]),
        "beta_quality":       float(coeffs[3]),
        "idiosyncratic_60d":  float(np.mean(resid)),
        "r_squared":          float(r_sq),
        "n_obs":              int(n_obs),
    }


# ── Upsert ────────────────────────────────────────────────────────────────────

def upsert_exposures(
    conn: mysql.connector.MySQLConnection,
    results: list[dict],
    as_of_date: date,
    dry_run: bool,
) -> int:
    """INSERT ... ON DUPLICATE KEY UPDATE for each ticker's exposures."""
    if not results:
        return 0

    if dry_run:
        print(f"[compute_factor_returns] DRY RUN — would upsert {len(results)} rows")
        return len(results)

    sql = """
        INSERT INTO factor_exposures
            (ticker, as_of_date, beta_value, beta_size, beta_quality,
             idiosyncratic_60d, n_obs, r_squared)
        VALUES
            (%s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            beta_value        = VALUES(beta_value),
            beta_size         = VALUES(beta_size),
            beta_quality      = VALUES(beta_quality),
            idiosyncratic_60d = VALUES(idiosyncratic_60d),
            n_obs             = VALUES(n_obs),
            r_squared         = VALUES(r_squared)
    """
    cur = conn.cursor()
    rows_written = 0
    for r in results:
        def _round(v, d=4):
            return round(v, d) if v is not None else None

        cur.execute(sql, (
            r["ticker"],
            as_of_date,
            _round(r.get("beta_value")),
            _round(r.get("beta_size")),
            _round(r.get("beta_quality")),
            _round(r.get("idiosyncratic_60d")),
            r.get("n_obs"),
            _round(r.get("r_squared"), 4),
        ))
        rows_written += 1

    conn.commit()
    cur.close()
    return rows_written


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()

    as_of_date   = date.fromisoformat(args.as_of_date)
    start_date   = as_of_date - timedelta(days=args.lookback_days)

    print(f"[compute_factor_returns] as_of_date={as_of_date}  "
          f"lookback={args.lookback_days}d  start={start_date}  "
          f"tickers={args.tickers}  dry_run={args.dry_run}")

    # ── Connect DB ─────────────────────────────────────────────────────────────
    try:
        conn = get_db()
    except mysql.connector.Error as exc:
        print(f"[compute_factor_returns] DB connection failed: {exc}", file=sys.stderr)
        sys.exit(1)

    # ── Ensure table ───────────────────────────────────────────────────────────
    ensure_table(conn)

    # ── Universe ───────────────────────────────────────────────────────────────
    universe = get_universe(conn, args.tickers)
    if not universe:
        print("[compute_factor_returns] No tickers found in universe", file=sys.stderr)
        conn.close()
        sys.exit(1)

    print(f"[compute_factor_returns] Universe: {len(universe)} tickers")
    symbols = [row["symbol"] for row in universe]

    # ── Fetch prices ───────────────────────────────────────────────────────────
    prices_df = fetch_prices(symbols, start_date, as_of_date)
    if prices_df.empty:
        print("[compute_factor_returns] No price data fetched", file=sys.stderr)
        conn.close()
        sys.exit(1)

    # ── Fundamentals DataFrame ─────────────────────────────────────────────────
    fundamentals_df = pd.DataFrame(universe)

    # ── Factor returns ─────────────────────────────────────────────────────────
    factor_returns_df = compute_factor_returns(prices_df, fundamentals_df, as_of_date)
    if factor_returns_df.empty:
        print("[compute_factor_returns] Could not build factor return series", file=sys.stderr)
        conn.close()
        sys.exit(1)

    print(f"[compute_factor_returns] Factor return series: {len(factor_returns_df)} days")

    # ── Per-ticker daily returns ───────────────────────────────────────────────
    daily_returns = prices_df.pct_change()

    # ── Compute exposures ──────────────────────────────────────────────────────
    results: list[dict] = []
    skipped = 0
    r_squared_vals: list[float] = []

    for ticker in prices_df.columns:
        if ticker not in daily_returns.columns:
            skipped += 1
            continue

        ticker_ret = daily_returns[ticker].dropna()
        exp = compute_exposures(ticker, ticker_ret, factor_returns_df)
        if exp is None:
            skipped += 1
            continue

        exp["ticker"] = ticker
        results.append(exp)
        r_squared_vals.append(exp["r_squared"])

    print(f"[compute_factor_returns] Exposures computed: {len(results)} tickers "
          f"({skipped} skipped)")

    # ── Upsert ─────────────────────────────────────────────────────────────────
    written = upsert_exposures(conn, results, as_of_date, args.dry_run)
    conn.close()

    # ── Summary ────────────────────────────────────────────────────────────────
    avg_r2 = float(np.mean(r_squared_vals)) if r_squared_vals else 0.0
    print(
        f"\n[compute_factor_returns] DONE\n"
        f"  Tickers processed : {len(results)}\n"
        f"  Rows written      : {written}\n"
        f"  Avg R²            : {avg_r2:.4f}\n"
        f"  As-of date        : {as_of_date}"
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[compute_factor_returns] Interrupted by user", file=sys.stderr)
        sys.exit(1)
