"""
backfill_fundamentals.py — Populate yahoo_historical_fundamentals for the
ticker universe using yfinance's quarterly statements.

For each ticker in the `stocks` table (or --tickers list), fetches:
  - quarterly cashflow → freeCashFlow, operatingCashFlow, capitalExpenditure
  - quarterly balance sheet → totalCash, totalDebt
  - quarterly income statement → totalRevenue, ebitda, netIncome
  - price on each period-end date (from stocksdailyprice or yfinance history)

Derives EPS from netIncome / sharesOutstanding when possible, plus per-quarter
market cap using period-end price × shares outstanding.

Idempotent: uses INSERT ... ON DUPLICATE KEY UPDATE so re-runs are safe. Skip
existing rows unless --refresh is passed.

Rate-limited: 0.6s sleep between tickers to avoid Yahoo throttling.

Usage:
  python3 scripts/backfill_fundamentals.py                    # all tickers in `stocks`
  python3 scripts/backfill_fundamentals.py AAPL MSFT NVDA     # explicit list
  python3 scripts/backfill_fundamentals.py --refresh          # overwrite existing rows
  python3 scripts/backfill_fundamentals.py --limit 100        # first 100 from stocks table
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta

import mysql.connector
import numpy as np
import pandas as pd
import yfinance as yf
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT = int(os.getenv('DB_PORT', 3306))


def db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT, autocommit=False,
    )


def _row_at(df: pd.DataFrame, key: str) -> pd.Series | None:
    """Return the row named `key` from a yfinance quarterly statement, or None.
    yfinance flips columns to periods and rows to metrics; we index by metric."""
    if df is None or df.empty:
        return None
    if key in df.index:
        return df.loc[key]
    return None


def _safe_num(v) -> float | None:
    try:
        f = float(v)
        return None if not np.isfinite(f) else f
    except (TypeError, ValueError):
        return None


def _closest_price(price_series: pd.Series, target) -> float | None:
    """Return the closing price on-or-before `target`, or None if no data before it.
    Normalizes tz-aware/tz-naive mismatch between yfinance price index (usually
    tz-aware, America/New_York) and quarterly-statement columns (usually
    tz-naive) by stripping tz info on both sides for the comparison."""
    if price_series is None or price_series.empty:
        return None
    # Normalize price index to tz-naive dates.
    idx = price_series.index
    if hasattr(idx, 'tz') and idx.tz is not None:
        idx = idx.tz_localize(None)
    # Normalize target to a naive Timestamp.
    t = pd.Timestamp(target)
    if hasattr(t, 'tz') and t.tz is not None:
        t = t.tz_localize(None)
    mask = idx <= t
    if not mask.any():
        return None
    # Use positional lookup so the normalized index doesn't have to match the
    # original for .loc lookups.
    positions = np.where(mask)[0]
    return _safe_num(price_series.iloc[positions[-1]])


def collect_ticker_fundamentals(ticker: str) -> list[dict]:
    """Fetch quarterly cashflow/balance/income + price at each period end.
    Returns a list of dicts, one per quarter, keyed by period_end_date."""
    try:
        yft = yf.Ticker(ticker)

        # yfinance quarterly statements — DataFrames with metrics as rows,
        # period-end dates as columns. Recent quarters first.
        # We also merge in the annual statements because yfinance only exposes
        # ~6 quarters, so pre-2025 training snapshots would otherwise have no
        # fundamentals. Annuals give us ~5 years of coverage at fiscal year end.
        def _merge(quarterly, annual):
            frames = [f for f in (quarterly, annual) if f is not None and not f.empty]
            if not frames:
                return None
            merged = pd.concat(frames, axis=1)
            # Deduplicate columns (a period appearing in both quarterly and
            # annual will use the quarterly value since we concatenate quarterly
            # first; keep the leftmost occurrence).
            merged = merged.loc[:, ~merged.columns.duplicated(keep='first')]
            return merged.sort_index(axis=1)

        cash_q   = _merge(yft.quarterly_cashflow,      yft.cashflow)
        bal_q    = _merge(yft.quarterly_balance_sheet, yft.balance_sheet)
        income_q = _merge(yft.quarterly_financials,    yft.financials)

        # Prices for 5 years — used to snapshot price_at_period_end per row.
        end_date   = date.today()
        start_date = end_date - timedelta(days=365 * 6)
        hist = yft.history(start=start_date.isoformat(), end=end_date.isoformat(), auto_adjust=True)
        price_series = hist['Close'] if not hist.empty else pd.Series(dtype=float)

        # Period columns: intersection of what all three statements report.
        periods_set: set = set()
        for df in (cash_q, bal_q, income_q):
            if df is not None and not df.empty:
                periods_set.update(df.columns)
        periods = sorted(periods_set)

        # Extract shared metric rows once.
        fcf_row   = _row_at(cash_q,   'Free Cash Flow')
        ocf_row   = _row_at(cash_q,   'Operating Cash Flow')
        capex_row = _row_at(cash_q,   'Capital Expenditure')
        # yfinance uses various names for "cash" — try the common ones.
        cash_row  = _row_at(bal_q,    'Cash And Cash Equivalents') \
                    if _row_at(bal_q, 'Cash And Cash Equivalents') is not None \
                    else _row_at(bal_q, 'Cash Cash Equivalents And Short Term Investments')
        debt_row  = _row_at(bal_q,    'Total Debt') \
                    if _row_at(bal_q, 'Total Debt') is not None \
                    else _row_at(bal_q, 'Long Term Debt')
        rev_row   = _row_at(income_q, 'Total Revenue')
        ebitda_row = _row_at(income_q, 'EBITDA') \
                    if _row_at(income_q, 'EBITDA') is not None \
                    else _row_at(income_q, 'Normalized EBITDA')
        ni_row    = _row_at(income_q, 'Net Income') \
                    if _row_at(income_q, 'Net Income') is not None \
                    else _row_at(income_q, 'Net Income Common Stockholders')
        eps_row   = _row_at(income_q, 'Diluted EPS') \
                    if _row_at(income_q, 'Diluted EPS') is not None \
                    else _row_at(income_q, 'Basic EPS')
        shares_row = _row_at(income_q, 'Diluted Average Shares') \
                    if _row_at(income_q, 'Diluted Average Shares') is not None \
                    else _row_at(income_q, 'Basic Average Shares')

        out: list[dict] = []
        for p in periods:
            period_end = p.date() if hasattr(p, 'date') else p
            price = _closest_price(price_series, p)
            shares = _safe_num(shares_row[p]) if shares_row is not None and p in shares_row.index else None
            eps = _safe_num(eps_row[p]) if eps_row is not None and p in eps_row.index else None
            netinc = _safe_num(ni_row[p]) if ni_row is not None and p in ni_row.index else None

            # If shares are missing but we have netincome + eps, derive shares.
            if shares is None and netinc is not None and eps not in (None, 0):
                shares = netinc / eps if eps != 0 else None

            market_cap = None
            if price is not None and shares is not None and shares > 0:
                market_cap = price * shares

            out.append({
                'symbol': ticker.upper(),
                'period_end_date': period_end,
                'free_cash_flow':       _safe_num(fcf_row[p])   if fcf_row   is not None and p in fcf_row.index   else None,
                'operating_cash_flow':  _safe_num(ocf_row[p])   if ocf_row   is not None and p in ocf_row.index   else None,
                'capital_expenditure':  _safe_num(capex_row[p]) if capex_row is not None and p in capex_row.index else None,
                'total_cash':           _safe_num(cash_row[p])  if cash_row  is not None and p in cash_row.index  else None,
                'total_debt':           _safe_num(debt_row[p])  if debt_row  is not None and p in debt_row.index  else None,
                'book_value_per_share': None,   # yfinance doesn't reliably expose this
                'total_revenue':        _safe_num(rev_row[p])   if rev_row   is not None and p in rev_row.index   else None,
                'ebitda':               _safe_num(ebitda_row[p]) if ebitda_row is not None and p in ebitda_row.index else None,
                'net_income':           netinc,
                'eps':                  eps,
                'price_at_period_end':  price,
                'shares_outstanding':   int(shares) if shares is not None and shares > 0 else None,
                'market_cap_at_period_end': int(market_cap) if market_cap is not None and market_cap > 0 else None,
            })
        return out
    except Exception as exc:
        print(f"  [error] {ticker}: {exc}", file=sys.stderr)
        return []


UPSERT_SQL = """
INSERT INTO yahoo_historical_fundamentals (
  symbol, period_end_date, free_cash_flow, operating_cash_flow, capital_expenditure,
  total_cash, total_debt, book_value_per_share, total_revenue, ebitda, net_income,
  eps, price_at_period_end, shares_outstanding, market_cap_at_period_end
) VALUES (
  %(symbol)s, %(period_end_date)s, %(free_cash_flow)s, %(operating_cash_flow)s,
  %(capital_expenditure)s, %(total_cash)s, %(total_debt)s, %(book_value_per_share)s,
  %(total_revenue)s, %(ebitda)s, %(net_income)s, %(eps)s, %(price_at_period_end)s,
  %(shares_outstanding)s, %(market_cap_at_period_end)s
) ON DUPLICATE KEY UPDATE
  free_cash_flow      = VALUES(free_cash_flow),
  operating_cash_flow = VALUES(operating_cash_flow),
  capital_expenditure = VALUES(capital_expenditure),
  total_cash          = VALUES(total_cash),
  total_debt          = VALUES(total_debt),
  total_revenue       = VALUES(total_revenue),
  ebitda              = VALUES(ebitda),
  net_income          = VALUES(net_income),
  eps                 = VALUES(eps),
  price_at_period_end = VALUES(price_at_period_end),
  shares_outstanding  = VALUES(shares_outstanding),
  market_cap_at_period_end = VALUES(market_cap_at_period_end)
"""


def has_existing_data(cursor, symbol: str) -> bool:
    cursor.execute("SELECT 1 FROM yahoo_historical_fundamentals WHERE symbol = %s LIMIT 1", (symbol,))
    return cursor.fetchone() is not None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('tickers', nargs='*', help='Explicit ticker list (default: all from `stocks`)')
    parser.add_argument('--refresh', action='store_true', help='Re-fetch even for tickers already ingested')
    parser.add_argument('--limit',   type=int, default=None, help='Limit to first N tickers from `stocks`')
    parser.add_argument('--sleep',   type=float, default=0.6, help='Seconds to sleep between tickers (default 0.6)')
    args = parser.parse_args()

    conn = db()
    cur = conn.cursor()

    if args.tickers:
        tickers = [t.upper().strip() for t in args.tickers]
    else:
        limit_sql = f"LIMIT {int(args.limit)}" if args.limit else ""
        cur.execute(f"SELECT symbol FROM stocks WHERE symbol IS NOT NULL ORDER BY symbol {limit_sql}")
        tickers = [r[0] for r in cur.fetchall()]

    print(f"[{datetime.now().isoformat()}] Backfilling fundamentals for {len(tickers)} ticker(s)...", file=sys.stderr)

    stats = {'processed': 0, 'skipped_existing': 0, 'rows_written': 0, 'errors': 0, 'no_data': 0}
    for i, ticker in enumerate(tickers, 1):
        if not args.refresh and has_existing_data(cur, ticker):
            stats['skipped_existing'] += 1
            continue

        rows = collect_ticker_fundamentals(ticker)
        if not rows:
            stats['no_data'] += 1
            print(f"  [{i:>4}/{len(tickers)}] {ticker}: no data", file=sys.stderr)
            continue

        try:
            cur.executemany(UPSERT_SQL, rows)
            conn.commit()
            stats['rows_written'] += len(rows)
            stats['processed']    += 1
            print(f"  [{i:>4}/{len(tickers)}] {ticker}: {len(rows)} quarters", file=sys.stderr)
        except Exception as exc:
            conn.rollback()
            stats['errors'] += 1
            print(f"  [{i:>4}/{len(tickers)}] {ticker}: DB error {exc}", file=sys.stderr)

        time.sleep(args.sleep)

    cur.close()
    conn.close()
    print(f"\n[{datetime.now().isoformat()}] Backfill complete. {stats}", file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f"[fatal] {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
