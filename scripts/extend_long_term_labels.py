#!/usr/bin/env python3
"""
extend_long_term_labels.py — add 63d / 126d forward-return labels to
ranking_training_snapshots so we can train a long-term cross-sectional
model on the existing GREEN-feature dataset.

The table currently only has the 20-day forward return that the ranker
uses. For 3m / 6m prediction we need labels at 63d and 126d. We compute
those from per-ticker price history (cached one yfinance pull per ticker)
and UPDATE the rows in place.

Idempotent:
  - Adds `forward_return_63d` and `forward_return_126d` columns if missing.
  - Skips rows that already have non-NULL labels (use --recompute to force).

Recent snapshots can't have 3m or 6m labels yet (the future hasn't
happened). Those rows are left NULL.

USAGE:
  python3 scripts/extend_long_term_labels.py
  python3 scripts/extend_long_term_labels.py --recompute       # overwrite existing labels
  python3 scripts/extend_long_term_labels.py --tickers AAPL,MSFT  # subset
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta
from typing import Optional

import pandas as pd
from dotenv import load_dotenv

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip install yfinance", file=sys.stderr)
    sys.exit(1)

import mysql.connector

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

HORIZON_DAYS = [
    ('forward_return_63d',  63),
    ('forward_return_126d', 126),
    ('forward_return_252d', 252),
]


def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def ensure_columns(conn):
    """Idempotent ALTER TABLE — add the 63d / 126d label columns if missing."""
    cur = conn.cursor()
    cur.execute("SHOW COLUMNS FROM ranking_training_snapshots")
    existing = {row[0] for row in cur.fetchall()}
    for col, _ in HORIZON_DAYS:
        if col not in existing:
            cur.execute(f"ALTER TABLE ranking_training_snapshots ADD COLUMN {col} DECIMAL(10,6) NULL")
            print(f"  [schema] added column {col}")
    conn.commit()


def fetch_price_history(ticker: str, lookback_years: int = 6) -> Optional[pd.DataFrame]:
    """Fetch full daily history once per ticker. Returns a DataFrame indexed
    by date with at least a 'Close' column, or None if the fetch fails."""
    try:
        start = (date.today() - timedelta(days=lookback_years * 365)).isoformat()
        df = yf.download(ticker, start=start, progress=False, auto_adjust=False)
        if df is None or df.empty:
            return None
        # yfinance sometimes returns a multi-index column DataFrame for single tickers
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        df.index = pd.to_datetime(df.index).date
        return df
    except Exception as exc:
        print(f"  [warn] yfinance fetch failed for {ticker}: {exc}", file=sys.stderr)
        return None


def compute_forward_return(prices: pd.DataFrame, anchor: date, horizon: int) -> Optional[float]:
    """Return (close[anchor + horizon trading days] / close[anchor] - 1).
    Both lookups use the next-trading-day fallback if the exact date isn't
    in the index. Returns None if either close is missing."""
    if 'Close' not in prices.columns:
        return None
    # First close on or after anchor
    anchor_idx = prices.index.searchsorted(anchor)
    if anchor_idx >= len(prices):
        return None
    anchor_close = float(prices['Close'].iloc[anchor_idx])
    if not (anchor_close > 0):
        return None

    target = anchor + timedelta(days=int(horizon * 1.45))  # cal-days approx of trading days
    target_idx = prices.index.searchsorted(target)
    if target_idx >= len(prices):
        return None  # future hasn't happened yet
    target_close = float(prices['Close'].iloc[target_idx])
    if not (target_close > 0):
        return None
    return (target_close / anchor_close) - 1.0


def process_ticker(conn, ticker: str, recompute: bool) -> tuple[int, int]:
    """Update all snapshots for this ticker. Returns (updated, skipped)."""
    cur = conn.cursor()
    null_check = ' OR '.join(f'{col} IS NULL' for col, _ in HORIZON_DAYS)
    if recompute:
        cur.execute(
            "SELECT id, snapshot_date FROM ranking_training_snapshots WHERE ticker = %s",
            (ticker,),
        )
    else:
        cur.execute(
            f"SELECT id, snapshot_date FROM ranking_training_snapshots "
            f"WHERE ticker = %s AND ({null_check})",
            (ticker,),
        )
    rows = cur.fetchall()
    if not rows:
        return (0, 0)

    prices = fetch_price_history(ticker)
    if prices is None:
        return (0, len(rows))

    set_clause = ', '.join(f'{col} = %s' for col, _ in HORIZON_DAYS)
    updated = 0
    skipped = 0
    for record_id, snapshot_date in rows:
        if hasattr(snapshot_date, 'date'):
            snapshot_date = snapshot_date.date()
        returns = [compute_forward_return(prices, snapshot_date, h) for _, h in HORIZON_DAYS]
        if all(r is None for r in returns):
            skipped += 1
            continue
        cur.execute(
            f"UPDATE ranking_training_snapshots SET {set_clause} WHERE id = %s",
            (*returns, record_id),
        )
        updated += 1
    conn.commit()
    return (updated, skipped)


def main():
    ap = argparse.ArgumentParser(description="Extend ranking_training_snapshots with 3m/6m labels")
    ap.add_argument('--recompute', action='store_true', help="Recompute even non-NULL labels")
    ap.add_argument('--tickers', type=str, default=None, help="Comma-separated subset (default: all)")
    args = ap.parse_args()

    conn = get_db()
    ensure_columns(conn)

    cur = conn.cursor()
    if args.tickers:
        ticker_list = [t.strip().upper() for t in args.tickers.split(',') if t.strip()]
    else:
        cur.execute("SELECT DISTINCT ticker FROM ranking_training_snapshots ORDER BY ticker")
        ticker_list = [row[0] for row in cur.fetchall()]

    total_updated = 0
    total_skipped = 0
    print(f"Processing {len(ticker_list)} ticker(s)...")
    for i, ticker in enumerate(ticker_list, 1):
        upd, skp = process_ticker(conn, ticker, args.recompute)
        total_updated += upd
        total_skipped += skp
        if i % 25 == 0 or i == len(ticker_list):
            print(f"  [{i}/{len(ticker_list)}] {ticker}: updated={upd} skipped={skp} "
                  f"(running totals: updated={total_updated} skipped={total_skipped})")

    # Final summary: how many rows have each label set
    cur.execute("""
        SELECT
          COUNT(*) AS total,
          SUM(forward_return_63d  IS NOT NULL) AS has_63d,
          SUM(forward_return_126d IS NOT NULL) AS has_126d
        FROM ranking_training_snapshots
    """)
    total, has_63d, has_126d = cur.fetchone()
    print(f"\nDone. Final label coverage:")
    print(f"  total rows:           {total}")
    print(f"  forward_return_63d:   {has_63d}/{total}  ({100*has_63d/total:.1f}%)")
    print(f"  forward_return_126d:  {has_126d}/{total} ({100*has_126d/total:.1f}%)")
    print(f"  this run:             updated={total_updated} skipped={total_skipped}")

    conn.close()


if __name__ == '__main__':
    main()
