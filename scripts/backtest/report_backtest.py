#!/usr/bin/env python3
"""
report_backtest.py — Text report of backtest results for one or more tickers.

For each ticker, joins prediction_records + prediction_details and prints:
  1. Header + overall accuracy per horizon (mean proximity + direction %)
  2. Details snapshot: static fields (industry, market_cap_bucket) + ranges
     for the dynamic ones (VIX, RSI, momentum, etc.)
  3. Accuracy segmented by:
       - VIX regime (low <15 / medium 15-25 / high >25)
       - SPY 30d trend (up >2% / flat / down <-2%)
       - Stock 30d momentum (up >5% / flat / down <-5%)
       - RSI bucket (oversold <30 / neutral / overbought >70)

When multiple tickers are given, a side-by-side comparison table is printed
first so overall accuracy per ticker is easy to eyeball.

Usage:
    python3 scripts/report_backtest.py AAPL
    python3 scripts/report_backtest.py AAPL MSFT NVDA
    python3 scripts/report_backtest.py AAPL --model-version v3split
    python3 scripts/report_backtest.py AAPL --from-date 2025-01-01
    python3 scripts/report_backtest.py AAPL --from-date 2025-01-01 --to-date 2025-12-31
    python3 scripts/report_backtest.py AAPL MSFT --from-date 2025-01-01 -o reports/multi.txt
"""
import os
import sys
import argparse
import contextlib
import mysql.connector
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

HORIZONS = ['1w', '1m', '3m', '6m']


def connect():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def q(cur, sql, params):
    cur.execute(sql, params)
    return cur.fetchall()


def section(title):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def fmt(v, spec='.2f', na='—'):
    if v is None:
        return na
    return format(float(v), spec)


def _f(v):
    """Coerce Decimal/None to float/None so arithmetic works uniformly."""
    return float(v) if v is not None else None


def _date_clause(prefix, from_date, to_date):
    """Return ('' or ' AND ...', [params]) for a predicted_at date window.
    prefix is '' (bare table) or 'pr.' (joined queries)."""
    parts, params = [], []
    if from_date:
        parts.append(f" AND {prefix}predicted_at >= %s")
        params.append(from_date)
    if to_date:
        parts.append(f" AND {prefix}predicted_at <= %s")
        params.append(to_date + ' 23:59:59')
    return ''.join(parts), params


def overall(cur, symbol, mv, from_date, to_date):
    window_note = ''
    if from_date or to_date:
        window_note = f"  [window: {from_date or '…'} → {to_date or '…'}]"
    section(f"{symbol} — overall accuracy ({mv}){window_note}")
    date_clause, date_params = _date_clause('', from_date, to_date)
    row = q(cur, f"""
        SELECT
          COUNT(*)                                         AS n,
          MIN(predicted_at)                                AS first_at,
          MAX(predicted_at)                                AS last_at,
          SUM(resolved_1w) AS r1w, SUM(resolved_1m) AS r1m,
          SUM(resolved_3m) AS r3m, SUM(resolved_6m) AS r6m,
          AVG(accuracy_pct_1w) AS a1w, AVG(accuracy_pct_1m) AS a1m,
          AVG(accuracy_pct_3m) AS a3m, AVG(accuracy_pct_6m) AS a6m,
          AVG(direction_correct_1w)*100 AS d1w,
          AVG(direction_correct_1m)*100 AS d1m,
          AVG(direction_correct_3m)*100 AS d3m,
          AVG(direction_correct_6m)*100 AS d6m
        FROM prediction_records
        WHERE symbol = %s AND model_version = %s{date_clause}
    """, (symbol, mv, *date_params))[0]
    n, first_at, last_at = row['n'], row['first_at'], row['last_at']
    if not n:
        print(f"  no rows found for {symbol} @ {mv}")
        return 0
    print(f"  predictions: {n}   window: {first_at} → {last_at}")
    print()
    print(f"  {'horizon':<8} {'resolved':>10} {'avg proximity':>16} {'direction %':>14}")
    print(f"  {'-'*8} {'-'*10} {'-'*16} {'-'*14}")
    for h in HORIZONS:
        r  = row[f'r{h}']
        a  = row[f'a{h}']
        d  = row[f'd{h}']
        print(f"  {h:<8} {int(r or 0):>10} {fmt(a, '.2f')+' %':>16} {fmt(d, '.1f')+' %':>14}")
    return n


def details_snapshot(cur, symbol, mv, from_date, to_date):
    section(f"{symbol} — details snapshot")
    date_clause, date_params = _date_clause('pr.', from_date, to_date)
    row = q(cur, f"""
        SELECT
          MIN(pd.industry)          AS industry,
          MIN(pd.market_cap_bucket) AS mc_bucket,
          MIN(pd.market_cap)        AS mc_min,
          MAX(pd.market_cap)        AS mc_max,
          AVG(pd.beta_snapshot)     AS beta_avg,
          AVG(pd.pe_ratio)          AS pe_avg,
          AVG(pd.sector_median_pe)  AS sector_pe,
          MIN(pd.vix_at_prediction) AS vix_min,
          AVG(pd.vix_at_prediction) AS vix_avg,
          MAX(pd.vix_at_prediction) AS vix_max,
          MIN(pd.yield_curve_spread) AS ycs_min,
          MAX(pd.yield_curve_spread) AS ycs_max,
          AVG(pd.avg_daily_volume_30d) AS vol_avg,
          MIN(pd.stock_return_30d) AS r30_min,
          AVG(pd.stock_return_30d) AS r30_avg,
          MAX(pd.stock_return_30d) AS r30_max,
          MIN(pd.stock_return_90d) AS r90_min,
          MAX(pd.stock_return_90d) AS r90_max,
          AVG(pd.realized_vol_30d) AS vol30_avg,
          MIN(pd.pct_from_52w_high) AS pct52_min,
          MAX(pd.pct_from_52w_high) AS pct52_max,
          MIN(pd.rsi_14d) AS rsi_min,
          AVG(pd.rsi_14d) AS rsi_avg,
          MAX(pd.rsi_14d) AS rsi_max
        FROM prediction_details pd
        JOIN prediction_records pr ON pr.id = pd.prediction_record_id
        WHERE pr.symbol = %s AND pr.model_version = %s{date_clause}
    """, (symbol, mv, *date_params))[0]

    if row['industry'] is None:
        print("  no prediction_details rows yet.")
        return

    for k in list(row.keys()):
        if k not in ('industry', 'mc_bucket'):
            row[k] = _f(row[k])

    def pct(v): return v * 100 if v is not None else None
    def bn(v):  return v / 1e9  if v is not None else None
    def mn(v):  return v / 1e6  if v is not None else None

    print("  static (from today's info dict — snapshot proxy):")
    print(f"    industry         : {row['industry']}")
    print(f"    market_cap_bucket: {row['mc_bucket']}")
    print(f"    market_cap range : {fmt(bn(row['mc_min']), '.1f')}B .. {fmt(bn(row['mc_max']), '.1f')}B")
    print(f"    beta (avg)       : {fmt(row['beta_avg'], '.3f')}")
    print(f"    PE (avg)         : {fmt(row['pe_avg'], '.2f')}   sector median: {fmt(row['sector_pe'], '.2f')}")
    print(f"    avg daily volume : {fmt(mn(row['vol_avg']), '.1f')}M shares")
    print()
    print("  point-in-time ranges over the backtest window:")
    print(f"    VIX               : {fmt(row['vix_min'], '.2f')} .. {fmt(row['vix_max'], '.2f')}   (avg {fmt(row['vix_avg'], '.2f')})")
    print(f"    yield curve spread: {fmt(row['ycs_min'], '.3f')} .. {fmt(row['ycs_max'], '.3f')} %")
    print(f"    stock return 30d  : {fmt(pct(row['r30_min']), '.1f')}% .. {fmt(pct(row['r30_max']), '.1f')}%   (avg {fmt(pct(row['r30_avg']), '.1f')}%)")
    print(f"    stock return 90d  : {fmt(pct(row['r90_min']), '.1f')}% .. {fmt(pct(row['r90_max']), '.1f')}%")
    print(f"    realized vol 30d  : {fmt(pct(row['vol30_avg']), '.1f')}% (avg, annualized)")
    print(f"    pct from 52w high : {fmt(pct(row['pct52_min']), '.1f')}% .. {fmt(pct(row['pct52_max']), '.1f')}%")
    print(f"    RSI 14d           : {fmt(row['rsi_min'], '.1f')} .. {fmt(row['rsi_max'], '.1f')}   (avg {fmt(row['rsi_avg'], '.1f')})")


def _segment(cur, symbol, mv, from_date, to_date, bucket_expr, order_expr, title):
    section(f"{symbol} — accuracy by {title}")
    date_clause, date_params = _date_clause('pr.', from_date, to_date)
    rows = q(cur, f"""
        SELECT
          {bucket_expr} AS bucket,
          COUNT(*)                         AS n,
          AVG(pr.accuracy_pct_1m)          AS a1m,
          AVG(pr.accuracy_pct_3m)          AS a3m,
          AVG(pr.accuracy_pct_6m)          AS a6m,
          AVG(pr.direction_correct_1m)*100 AS d1m,
          AVG(pr.direction_correct_3m)*100 AS d3m,
          AVG(pr.direction_correct_6m)*100 AS d6m
        FROM prediction_records pr
        JOIN prediction_details pd ON pd.prediction_record_id = pr.id
        WHERE pr.symbol = %s AND pr.model_version = %s{date_clause}
        GROUP BY bucket
        ORDER BY {order_expr}
    """, (symbol, mv, *date_params))
    if not rows:
        print("  (no rows)"); return
    print(f"  {'bucket':<14} {'n':>5}   {'1m acc':>8} {'3m acc':>8} {'6m acc':>8}   {'1m dir':>7} {'3m dir':>7} {'6m dir':>7}")
    print(f"  {'-'*14} {'-'*5}   {'-'*8} {'-'*8} {'-'*8}   {'-'*7} {'-'*7} {'-'*7}")
    for r in rows:
        print(f"  {str(r['bucket']):<14} {r['n']:>5}   "
              f"{fmt(r['a1m'], '.1f')+'%':>8} {fmt(r['a3m'], '.1f')+'%':>8} {fmt(r['a6m'], '.1f')+'%':>8}   "
              f"{fmt(r['d1m'], '.1f')+'%':>7} {fmt(r['d3m'], '.1f')+'%':>7} {fmt(r['d6m'], '.1f')+'%':>7}")


def segments(cur, symbol, mv, from_date, to_date):
    _segment(cur, symbol, mv, from_date, to_date,
        "CASE WHEN pd.vix_at_prediction < 15 THEN '1_low'"
        " WHEN pd.vix_at_prediction < 25 THEN '2_medium' ELSE '3_high' END",
        "bucket", "VIX regime")
    _segment(cur, symbol, mv, from_date, to_date,
        "CASE WHEN pd.spy_return_30d > 0.02 THEN '1_up'"
        " WHEN pd.spy_return_30d < -0.02 THEN '3_down' ELSE '2_flat' END",
        "bucket", "SPY 30d trend")
    _segment(cur, symbol, mv, from_date, to_date,
        "CASE WHEN pd.stock_return_30d > 0.05 THEN '1_up'"
        " WHEN pd.stock_return_30d < -0.05 THEN '3_down' ELSE '2_flat' END",
        "bucket", "stock 30d momentum")
    _segment(cur, symbol, mv, from_date, to_date,
        "CASE WHEN pd.rsi_14d < 30 THEN '1_oversold'"
        " WHEN pd.rsi_14d > 70 THEN '3_overbought' ELSE '2_neutral' END",
        "bucket", "RSI bucket")


def cross_ticker_summary(cur, symbols, mv, from_date, to_date):
    """Print one-row-per-ticker comparison of overall accuracy."""
    window_note = ''
    if from_date or to_date:
        window_note = f"  [window: {from_date or '…'} → {to_date or '…'}]"
    section(f"Cross-ticker summary ({mv}){window_note}")
    date_clause, date_params = _date_clause('', from_date, to_date)
    rows = []
    for sym in symbols:
        r = q(cur, f"""
            SELECT
              COUNT(*)                       AS n,
              AVG(accuracy_pct_1m)           AS a1m,
              AVG(accuracy_pct_3m)           AS a3m,
              AVG(accuracy_pct_6m)           AS a6m,
              AVG(direction_correct_1m)*100  AS d1m,
              AVG(direction_correct_3m)*100  AS d3m,
              AVG(direction_correct_6m)*100  AS d6m
            FROM prediction_records
            WHERE symbol = %s AND model_version = %s{date_clause}
        """, (sym, mv, *date_params))[0]
        r['symbol'] = sym
        rows.append(r)

    print(f"  {'symbol':<8} {'n':>5}   {'1m acc':>8} {'3m acc':>8} {'6m acc':>8}   {'1m dir':>7} {'3m dir':>7} {'6m dir':>7}")
    print(f"  {'-'*8} {'-'*5}   {'-'*8} {'-'*8} {'-'*8}   {'-'*7} {'-'*7} {'-'*7}")
    for r in rows:
        if not r['n']:
            print(f"  {r['symbol']:<8} {0:>5}   {'(no rows in window)'}")
            continue
        print(f"  {r['symbol']:<8} {r['n']:>5}   "
              f"{fmt(r['a1m'], '.1f')+'%':>8} {fmt(r['a3m'], '.1f')+'%':>8} {fmt(r['a6m'], '.1f')+'%':>8}   "
              f"{fmt(r['d1m'], '.1f')+'%':>7} {fmt(r['d3m'], '.1f')+'%':>7} {fmt(r['d6m'], '.1f')+'%':>7}")


def _run_report(cur, symbols, mv, from_date, to_date):
    if len(symbols) > 1:
        cross_ticker_summary(cur, symbols, mv, from_date, to_date)
    for symbol in symbols:
        n = overall(cur, symbol, mv, from_date, to_date)
        if n == 0:
            continue
        details_snapshot(cur, symbol, mv, from_date, to_date)
        segments(cur, symbol, mv, from_date, to_date)
    print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('symbols', nargs='+', help='One or more ticker symbols')
    ap.add_argument('--model-version', default='v3split')
    ap.add_argument('--from-date', dest='from_date', help='Only include predictions on or after this date (YYYY-MM-DD)')
    ap.add_argument('--to-date',   dest='to_date',   help='Only include predictions on or before this date (YYYY-MM-DD)')
    ap.add_argument('-o', '--output', help='Write the report to this file instead of stdout')
    args = ap.parse_args()
    symbols = [s.upper() for s in args.symbols]

    conn = connect()
    cur = conn.cursor(dictionary=True)
    try:
        if args.output:
            with open(args.output, 'w') as fh, contextlib.redirect_stdout(fh):
                _run_report(cur, symbols, args.model_version, args.from_date, args.to_date)
            print(f"Report written to {args.output}", file=sys.stderr)
        else:
            _run_report(cur, symbols, args.model_version, args.from_date, args.to_date)
    finally:
        cur.close(); conn.close()


if __name__ == '__main__':
    main()
