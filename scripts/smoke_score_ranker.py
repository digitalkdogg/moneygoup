#!/usr/bin/env python3
"""
Smoke test for scripts/score_ranker.py.

Fetches fresh OHLCV + macro from yfinance for a handful of tickers, packages
them into the batch payload format score_ranker.py expects, runs the script,
and prints the scored ranks. Lets you validate the full inference pipeline
(features → model → percentile rank) without standing up the TS side.

USAGE:
  python scripts/smoke_score_ranker.py
      [--tickers AAPL,MSFT,NVDA,JPM,XOM]   # default 5-stock universe
      [--keep-fixture /tmp/foo.json]        # save payload for re-runs
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed; run: pip install yfinance", file=sys.stderr)
    sys.exit(1)


PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Sector mapping for the default 5 tickers. For larger universes you'd want
# to share the lookup with build_ranking_dataset.py's sector_map.json cache.
DEFAULT_SECTORS = {
    "AAPL": "Technology",
    "MSFT": "Technology",
    "NVDA": "Technology",
    "JPM":  "Financials",
    "XOM":  "Energy",
}
SECTOR_ETF = {
    "Technology": "XLK", "Healthcare": "XLV", "Financials": "XLF",
    "Financial Services": "XLF", "Consumer Cyclical": "XLY",
    "Consumer Defensive": "XLP", "Industrials": "XLI", "Energy": "XLE",
    "Utilities": "XLU", "Real Estate": "XLRE", "Basic Materials": "XLB",
    "Materials": "XLB", "Communication Services": "XLC",
}


def fetch_ohlcv(ticker: str, period: str = "2y"):
    df = yf.download(ticker, period=period, progress=False, auto_adjust=True, threads=False)
    if df.empty:
        return []
    # Handle yfinance's MultiIndex columns when only one ticker is downloaded.
    if hasattr(df.columns, "nlevels") and df.columns.nlevels > 1:
        df.columns = df.columns.get_level_values(0)
    rows = []
    for idx, r in df.iterrows():
        rows.append({
            "date":   idx.strftime("%Y-%m-%d"),
            "open":   float(r.get("Open", 0) or 0),
            "high":   float(r.get("High", 0) or 0),
            "low":    float(r.get("Low", 0) or 0),
            "close":  float(r.get("Close", 0) or 0),
            "volume": float(r.get("Volume", 0) or 0),
        })
    return rows


def fetch_macro(sym: str):
    return fetch_ohlcv(sym, period="5y")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default=",".join(DEFAULT_SECTORS.keys()))
    ap.add_argument("--keep-fixture", default=None, help="Save built payload to a file for re-runs.")
    args = ap.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    print(f"[smoke] tickers: {tickers}", file=sys.stderr)

    print("[smoke] fetching macro series (~10 calls)...", file=sys.stderr)
    macro = {
        "vix":         fetch_macro("^VIX"),
        "treasury10y": fetch_macro("^TNX"),
        "treasury3m":  fetch_macro("^IRX"),
        "spy":         fetch_macro("SPY"),
        "hyg":         fetch_macro("HYG"),
        "lqd":         fetch_macro("LQD"),
        "dxy":         fetch_macro("DX-Y.NYB"),
        "wti":         fetch_macro("CL=F"),
        "copper":      fetch_macro("HG=F"),
        "wheat":       fetch_macro("ZW=F"),
    }
    sector_etfs_needed = sorted({SECTOR_ETF[DEFAULT_SECTORS.get(t, "Technology")] for t in tickers})
    print(f"[smoke] fetching sector ETFs: {sector_etfs_needed}", file=sys.stderr)
    sector_data = {etf: fetch_macro(etf) for etf in sector_etfs_needed}

    print("[smoke] fetching per-ticker OHLCV...", file=sys.stderr)
    candidates = []
    for t in tickers:
        ohlcv = fetch_ohlcv(t)
        if not ohlcv:
            print(f"  [smoke] no data for {t}, skipping", file=sys.stderr)
            continue
        sector = DEFAULT_SECTORS.get(t, "Technology")
        etf = SECTOR_ETF.get(sector, "XLK")
        candidates.append({
            "ticker": t,
            "historicalData": ohlcv,
            "macroData": {
                **macro,
                "sectorEtf": {"ticker": etf, "data": sector_data.get(etf, [])},
                # Synthetic WB scalars — the ranker uses defaults if missing anyway.
                "worldBank": {"indicators": {
                    "gdpGrowth":         2.5,
                    "inflation":         3.0,
                    "consumptionGrowth": 2.0,
                }},
            },
        })

    payload = {"snapshot_date": date.today().isoformat(), "candidates": candidates}

    fixture_path = Path(args.keep_fixture) if args.keep_fixture else Path("/tmp/ranker_smoke_input.json")
    fixture_path.write_text(json.dumps(payload))
    print(f"[smoke] wrote {len(candidates)} candidates to {fixture_path}", file=sys.stderr)

    print("[smoke] running scripts/score_ranker.py ...", file=sys.stderr)
    result = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "scripts" / "score_ranker.py"),
         "--input-file", str(fixture_path)],
        capture_output=True, text=True, cwd=str(PROJECT_ROOT),
    )
    if result.returncode != 0:
        print("[smoke] FAILED", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        return 1

    out = json.loads(result.stdout)
    print()
    print(f"model:            {out['model_path']}")
    print(f"feature_set_ver:  {out['feature_set_version']}")
    print(f"snapshot_date:    {out['snapshot_date']}")
    print(f"scored:           {out['scored_count']}    skipped: {out['skipped']}")
    print()
    print(f"{'ticker':<8}{'rank_pct':>12}{'raw_score':>14}{'hist_vol_30':>14}")
    print("-" * 48)
    for ticker, info in sorted(out["scores"].items(), key=lambda x: -x[1]["rank_pct"]):
        hv = info.get("hist_vol_30")
        hv_s = f"{hv:.4f}" if hv is not None else "  --"
        print(f"{ticker:<8}{info['rank_pct']:>12.4f}{info['raw_score']:>14.6f}{hv_s:>14}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
