"""
compute_sector_medians.py — Populate `sector_median_history` from
`yahoo_historical_fundamentals`.

For each (sector, period_end_date) tuple we can construct, compute the median
of key valuation ratios across all stocks in that sector on that date. These
medians are what the training and inference feature builders use for
sector-relative log ratios (PE_LogRatio_vs_Sector etc.).

Idempotent: `INSERT ... ON DUPLICATE KEY UPDATE`. Cheap to re-run.

Usage:
  python3 scripts/compute_sector_medians.py
  python3 scripts/compute_sector_medians.py --min-stocks 3  (default 5)
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime

import mysql.connector
import pandas as pd
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)


def db():
    return mysql.connector.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD'),
        database=os.getenv('DB_DATABASE'),
        port=int(os.getenv('DB_PORT', 3306)),
        autocommit=False,
    )


UPSERT_SQL = """
INSERT INTO sector_median_history (
  sector, period_end_date, pe_median, pb_median, ps_median,
  ev_ebitda_median, ev_revenue_median, fcf_yield_median,
  revenue_growth_median, earnings_growth_median, profit_margins_median, n_stocks
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON DUPLICATE KEY UPDATE
  pe_median = VALUES(pe_median),
  pb_median = VALUES(pb_median),
  ps_median = VALUES(ps_median),
  ev_ebitda_median = VALUES(ev_ebitda_median),
  ev_revenue_median = VALUES(ev_revenue_median),
  fcf_yield_median = VALUES(fcf_yield_median),
  revenue_growth_median = VALUES(revenue_growth_median),
  earnings_growth_median = VALUES(earnings_growth_median),
  profit_margins_median = VALUES(profit_margins_median),
  n_stocks = VALUES(n_stocks),
  computed_at = CURRENT_TIMESTAMP
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--min-stocks', type=int, default=5,
                        help='Minimum stocks in a sector to publish a median (default 5)')
    args = parser.parse_args()

    # Sector mapping comes from the JSON cache that build_ranking_dataset.py
    # already maintains (populated from Yahoo assetProfile.sector). Missing
    # tickers fall into the '_default' bucket so we still emit population-wide
    # medians. There's no sector column on the `stocks` table itself.
    import json
    sector_cache_path = os.path.join(PROJECT_ROOT, 'scripts', 'prediction_cache', 'sector_map.json')
    try:
        with open(sector_cache_path) as f:
            sector_map = json.load(f)
    except FileNotFoundError:
        print(f"[warn] {sector_cache_path} not found — falling back to _default sector for all rows", file=sys.stderr)
        sector_map = {}

    conn = db()
    cur = conn.cursor(dictionary=True)

    print(f"[{datetime.now().isoformat()}] Loading fundamentals...", file=sys.stderr)
    cur.execute("""
        SELECT
          symbol, period_end_date,
          eps, price_at_period_end AS price,
          total_revenue, ebitda, net_income,
          total_cash, total_debt,
          free_cash_flow, market_cap_at_period_end AS mkt,
          shares_outstanding AS shares
        FROM yahoo_historical_fundamentals
        WHERE price_at_period_end IS NOT NULL
    """)
    rows = cur.fetchall()
    # Attach sector via the JSON map (default = _default bucket).
    for r in rows:
        r['sector'] = sector_map.get(r['symbol'], '_default')
    print(f"  {len(rows):,} rows loaded, mapped to {len(set(r['sector'] for r in rows))} sectors", file=sys.stderr)

    df = pd.DataFrame(rows)
    if df.empty:
        print("[warn] no rows to aggregate", file=sys.stderr)
        return

    # Compute per-stock ratios (using period-end price + shares).
    df = df[df['price'] > 0]
    df['pe']         = df['price'] / df['eps'].where(df['eps'] > 0)
    df['ps']         = df['mkt']   / df['total_revenue'].where(df['total_revenue'] > 0)
    # Enterprise Value ≈ marketCap + debt - cash
    df['ev']         = df['mkt'] + df['total_debt'].fillna(0) - df['total_cash'].fillna(0)
    df['ev_ebitda']  = df['ev'] / df['ebitda'].where(df['ebitda'] > 0)
    df['ev_revenue'] = df['ev'] / df['total_revenue'].where(df['total_revenue'] > 0)
    df['fcf_yield']  = df['free_cash_flow'] / df['mkt'].where(df['mkt'] > 0)
    # profit margin = netincome / revenue (both trailing quarter)
    df['profit_margin'] = df['net_income'] / df['total_revenue'].where(df['total_revenue'] != 0)

    grouped = df.groupby(['sector', 'period_end_date'])
    upserts = []
    for (sector, period), g in grouped:
        n = len(g)
        if n < args.min_stocks:
            continue
        def _med(col):
            v = g[col].dropna()
            return float(v.median()) if not v.empty else None
        upserts.append((
            sector, period,
            _med('pe'),
            None,  # pb_median — book value not currently ingested reliably
            _med('ps'),
            _med('ev_ebitda'),
            _med('ev_revenue'),
            _med('fcf_yield'),
            None,  # revenue_growth_median — QoQ growth requires prior quarter data
            None,  # earnings_growth_median — same
            _med('profit_margin'),
            n,
        ))

    cur.close()
    cur = conn.cursor()
    print(f"  writing {len(upserts):,} (sector, period_end_date) rows...", file=sys.stderr)
    cur.executemany(UPSERT_SQL, upserts)
    conn.commit()
    cur.close()
    conn.close()
    print(f"[{datetime.now().isoformat()}] Sector-median compute done.", file=sys.stderr)


if __name__ == '__main__':
    main()
