#!/usr/bin/env python3
"""
scripts/fundamentals_anomaly_triage.py — Item 4.

Two-stage anomaly detector for yahoo_historical_fundamentals rows written by
scripts/backfill_fundamentals.py:

  Stage 1 (cheap): pandas/numpy filter picks a small set of statistical
  outliers per ticker — implicit price-to-earnings extremes, quarter-over-
  quarter revenue jumps > 300%, EPS sign flips with ≥10× magnitude change.
  Expected volume: a handful per run, not thousands.

  Stage 2 (LLM): each Stage-1 candidate gets sent to Ollama with the last N
  quarters of context for that metric. The LLM decides whether it's a data
  error (unit mismatch, stock split not adjusted, wrong currency) or a real
  business event (merger, impairment, divestiture). The row's
  flagged_anomaly + anomaly_reason columns are UPDATE'd with the result.

  NEVER auto-deletes or auto-corrects. Downstream consumers
  (build_ranking_dataset.py) filter with WHERE flagged_anomaly = 0 OR IS NULL.

Ollama failure = graceful skip. Exits 0 with a warning if disabled/unreachable
so this can slot into the nightly cron alongside resolve_predictions.py.

Usage:
  python3 scripts/fundamentals_anomaly_triage.py                     # scan all tickers
  python3 scripts/fundamentals_anomaly_triage.py --symbols AAPL MSFT  # scoped scan
  python3 scripts/fundamentals_anomaly_triage.py --dry-run            # print candidates, don't call Ollama or write
  python3 scripts/fundamentals_anomaly_triage.py --since 2026-01-01   # only quarters after this date
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from typing import List, Optional

import mysql.connector
import pandas as pd
from dotenv import load_dotenv

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))

from ollama_client import (
    is_ollama_enabled,
    check_ollama_reachable,
    generate_json,
    load_prompt,
)
if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

# Longer than default because we're asking for reasoning, and the LLM sees
# a mini-table of 4 quarters. Cold-starts push a full 8s otherwise.
TRIAGE_TIMEOUT_MS   = int(os.getenv('OLLAMA_TIMEOUT_MS_TRIAGE', '30000'))
TRIAGE_NUM_PREDICT  = 120
TRIAGE_TEMPERATURE  = 0.1

# Stage-1 filter thresholds. Wide bounds so we only catch clear outliers —
# false positives here waste Ollama calls, false negatives cost nothing.
PE_ABSOLUTE_MAX     = 500.0     # implicit PE > 500 is basically always a data glitch
QOQ_REVENUE_MAX_PCT = 3.0       # QoQ revenue growth > +300% is almost always a data issue
EPS_SIGN_FLIP_MULT  = 10.0      # sign flip AND |new| >= 10× |prev| suggests split/currency


def _connect():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


# ---------------------------------------------------------------------------
# Stage 1 — cheap statistical filter
# ---------------------------------------------------------------------------
def _find_candidates(df: pd.DataFrame) -> pd.DataFrame:
    """Return only the rows that look suspicious. df is one ticker's quarters
    sorted oldest→newest with columns:
        rowid, symbol, period_end_date, total_revenue, eps,
        price_at_period_end, net_income, market_cap_at_period_end
    """
    if df.empty:
        return df.iloc[0:0]

    df = df.sort_values('period_end_date').copy()
    df['flag_pe']       = False
    df['flag_qoq_rev']  = False
    df['flag_eps_flip'] = False

    # Implicit PE = market_cap / net_income (annualized approximation via TTM
    # would be more correct, but this is a coarse outlier filter so quarter-
    # level is fine). PE only meaningful when net_income > 0.
    ni = df['net_income'].astype(float)
    mc = df['market_cap_at_period_end'].astype(float)
    with pd.option_context('mode.use_inf_as_na', True):
        implicit_pe = (mc / (ni * 4)).where((ni > 0) & (mc > 0))
    df.loc[implicit_pe.abs() > PE_ABSOLUTE_MAX, 'flag_pe'] = True

    # QoQ revenue growth — flag when the jump is > +300%. A jump that big
    # is almost always a unit mismatch (e.g. row erroneously entered as
    # billions where the rest are millions).
    rev = df['total_revenue'].astype(float)
    prev_rev = rev.shift(1)
    with pd.option_context('mode.use_inf_as_na', True):
        qoq = ((rev - prev_rev) / prev_rev.abs()).where(prev_rev.abs() > 0)
    df.loc[qoq > QOQ_REVENUE_MAX_PCT, 'flag_qoq_rev'] = True

    # EPS sign flip + magnitude blowup — suggests missed split or currency.
    eps = df['eps'].astype(float)
    prev_eps = eps.shift(1)
    sign_flip = (eps * prev_eps < 0)
    with pd.option_context('mode.use_inf_as_na', True):
        magnitude_ratio = (eps.abs() / prev_eps.abs()).where(prev_eps.abs() > 0)
    df.loc[sign_flip & (magnitude_ratio >= EPS_SIGN_FLIP_MULT), 'flag_eps_flip'] = True

    any_flag = df['flag_pe'] | df['flag_qoq_rev'] | df['flag_eps_flip']
    return df[any_flag].copy()


# ---------------------------------------------------------------------------
# Stage 2 — LLM triage per candidate
# ---------------------------------------------------------------------------
def _quarter_context(all_df: pd.DataFrame, target_date, metric_col: str, n: int = 4) -> str:
    """Return an ascii table of the last `n` quarters ending at target_date."""
    sub = (all_df[all_df['period_end_date'] <= target_date]
           .sort_values('period_end_date')
           .tail(n))
    lines = []
    for _, row in sub.iterrows():
        val = row.get(metric_col)
        lines.append(f"  {row['period_end_date']}: {metric_col}={val}")
    return '\n'.join(lines) if lines else '  (no prior quarters)'


def _triage_candidate(row: dict, ticker_df: pd.DataFrame) -> Optional[dict]:
    """Ask Ollama: is this row a data error? Returns
    {'is_error': bool, 'reason': str} or None on any failure."""
    reasons = []
    metric_col = 'total_revenue'  # default
    if row.get('flag_qoq_rev'):
        metric_col = 'total_revenue'
        reasons.append('QoQ revenue jump > 300%')
    if row.get('flag_eps_flip'):
        metric_col = 'eps'
        reasons.append('EPS sign flip with ≥10× magnitude change')
    if row.get('flag_pe'):
        # PE spans two metrics — show both
        metric_col = 'net_income'
        reasons.append('implicit PE > 500')

    context = _quarter_context(ticker_df, row['period_end_date'], metric_col, n=4)
    flagged = f"  {row['period_end_date']}: {metric_col}={row.get(metric_col)}   (reasons: {'; '.join(reasons)})"

    try:
        prompt = load_prompt(
            'fundamentals_anomaly',
            ticker=row['symbol'],
            metric=metric_col,
            context_rows=context,
            flagged_row=flagged,
        )
    except FileNotFoundError:
        return None

    parsed = generate_json(
        prompt,
        timeout_ms=TRIAGE_TIMEOUT_MS,
        temperature=TRIAGE_TEMPERATURE,
        num_predict=TRIAGE_NUM_PREDICT,
    )
    if not isinstance(parsed, dict):
        return None
    is_err = bool(parsed.get('is_error'))
    reason = str(parsed.get('reason') or '')[:500].strip()
    if not reason:
        return None
    return {'is_error': is_err, 'reason': reason}


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------
def _update_row(cur, symbol: str, period_end_date, is_error: bool, reason: str) -> None:
    """Set flagged_anomaly + anomaly_reason on the specific (symbol, period_end_date)
    row. Existing anomaly_reason is overwritten so re-runs converge on the
    latest LLM opinion."""
    cur.execute("""
        UPDATE yahoo_historical_fundamentals
           SET flagged_anomaly = %s,
               anomaly_reason  = %s
         WHERE symbol = %s AND period_end_date = %s
    """, (1 if is_error else 0, reason, symbol, period_end_date))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('--symbols', nargs='+', help='Restrict to these tickers (default: all)')
    ap.add_argument('--since',   help='YYYY-MM-DD — only inspect quarters on or after this date')
    ap.add_argument('--dry-run', action='store_true', help='Print Stage 1 candidates; do NOT call Ollama or write')
    args = ap.parse_args()

    # Ollama pre-flight (skipped in dry-run).
    if not args.dry_run:
        if not is_ollama_enabled():
            print('[triage] OLLAMA_ENABLED=false — skipping', file=sys.stderr)
            return 0
        if not check_ollama_reachable():
            print('[triage] Ollama daemon unreachable — skipping', file=sys.stderr)
            return 0

    conn = _connect()
    cur = conn.cursor(dictionary=True)

    # Load fundamentals (optionally scoped to a ticker + date filter).
    where, params = [], []
    if args.symbols:
        placeholders = ','.join(['%s'] * len(args.symbols))
        where.append(f"symbol IN ({placeholders})")
        params.extend([s.upper() for s in args.symbols])
    if args.since:
        where.append('period_end_date >= %s')
        params.append(args.since)
    where_sql = f"WHERE {' AND '.join(where)}" if where else ''

    cur.execute(f"""
        SELECT symbol, period_end_date, total_revenue, eps, net_income,
               market_cap_at_period_end, price_at_period_end,
               flagged_anomaly
        FROM yahoo_historical_fundamentals
        {where_sql}
    """, tuple(params))
    all_rows = cur.fetchall()
    if not all_rows:
        print(f'[triage] No rows to inspect', file=sys.stderr)
        cur.close(); conn.close()
        return 0

    all_df = pd.DataFrame(all_rows)

    # Stage 1: find candidates per ticker.
    candidates_frames: List[pd.DataFrame] = []
    for sym, sub_df in all_df.groupby('symbol'):
        c = _find_candidates(sub_df)
        if not c.empty:
            candidates_frames.append(c)
    if not candidates_frames:
        print('[triage] No Stage-1 outliers detected — nothing to triage', file=sys.stderr)
        cur.close(); conn.close()
        return 0

    candidates_df = pd.concat(candidates_frames, ignore_index=True)
    print(f'[triage] Stage 1: {len(candidates_df)} candidate rows across '
          f'{candidates_df["symbol"].nunique()} tickers', file=sys.stderr)

    if args.dry_run:
        for _, row in candidates_df.iterrows():
            flags = [k for k in ('flag_pe', 'flag_qoq_rev', 'flag_eps_flip') if row.get(k)]
            print(f"  {row['symbol']} {row['period_end_date']} — flags={flags}")
        cur.close(); conn.close()
        return 0

    # Stage 2: LLM triage each candidate, UPDATE row on decision.
    flagged_error = 0
    flagged_ok    = 0
    skipped       = 0
    for _, row in candidates_df.iterrows():
        ticker_df = all_df[all_df['symbol'] == row['symbol']].sort_values('period_end_date')
        verdict = _triage_candidate(row.to_dict(), ticker_df)
        if verdict is None:
            skipped += 1
            continue
        _update_row(cur, row['symbol'], row['period_end_date'],
                    verdict['is_error'], verdict['reason'])
        if verdict['is_error']:
            flagged_error += 1
            print(f"  [ERR] {row['symbol']} {row['period_end_date']} → {verdict['reason']}", file=sys.stderr)
        else:
            flagged_ok += 1

    conn.commit()
    cur.close(); conn.close()

    print(f'[triage] Complete. flagged_as_error={flagged_error} '
          f'flagged_as_ok={flagged_ok} skipped_ollama_failure={skipped}',
          file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
