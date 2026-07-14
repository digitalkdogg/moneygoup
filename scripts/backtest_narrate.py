#!/usr/bin/env python3
"""
scripts/backtest_narrate.py — LLM-written prose summary of a backtest run.

For each ticker + horizon, pulls overall proximity + direction accuracy from
prediction_records and the worst 30d-momentum-bucket direction accuracy from
prediction_details. Optionally computes a prior-week window for delta lines.
Ships the numbers as compact JSON to Ollama, which returns a <150 word
narrative that gets written to reports/backtest_narrative_<date>.txt.

Meant to run overnight after resolve_predictions.py. Reads the same tables
report_backtest.py does — reuses that module's connect() and _date_clause()
helpers so both stay in lockstep.

Ollama failure never blocks the cron: script logs a warning and exits 0 if
the daemon is disabled, unreachable, timed out, or returns bad JSON.

Usage:
  python3 scripts/backtest_narrate.py AAPL MSFT NVDA
  python3 scripts/backtest_narrate.py AAPL --model-version v5 --from-date 2025-01-01
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta
from typing import List, Optional

# Reuse the DB connection helper from report_backtest — same env-loading,
# same connection args. Keeps this script and the reporter in lockstep.
from report_backtest import connect, _date_clause

# Ollama client + prompt loader from Item 0.
from ollama_client import (
    is_ollama_enabled,
    check_ollama_reachable,
    generate,
    load_prompt,
)


REPORTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'reports')
# Longer timeout than the shared default — narratives read a bigger prompt
# (per-ticker table of horizons + optional prior-week block) and produce
# a longer response than yes/no or extraction tasks. 60s is generous but
# safe for a run that only fires once nightly.
NARRATIVE_TIMEOUT_MS = int(os.getenv('OLLAMA_TIMEOUT_MS_NARRATIVE', '60000'))
NARRATIVE_NUM_PREDICT = 350
NARRATIVE_TEMPERATURE = 0.2


def _horizon_stats(cur, symbol: str, mv: str, from_date: Optional[str], to_date: Optional[str]) -> dict:
    """Compact per-horizon summary: n resolved, proximity avg, direction pct."""
    date_clause, date_params = _date_clause('', from_date, to_date)
    cur.execute(f"""
        SELECT
          SUM(resolved_1w) AS r1w, SUM(resolved_1m) AS r1m,
          SUM(resolved_6m) AS r6m, SUM(resolved_1y) AS r1y,
          AVG(accuracy_pct_1w) AS a1w, AVG(accuracy_pct_1m) AS a1m,
          AVG(accuracy_pct_6m) AS a6m, AVG(accuracy_pct_1y) AS a1y,
          AVG(direction_correct_1w) * 100 AS d1w,
          AVG(direction_correct_1m) * 100 AS d1m,
          AVG(direction_correct_6m) * 100 AS d6m,
          AVG(direction_correct_1y) * 100 AS d1y
        FROM prediction_records
        WHERE symbol = %s AND model_version = %s{date_clause}
    """, (symbol, mv, *date_params))
    row = cur.fetchone()

    def _flt(v):
        return round(float(v), 1) if v is not None else None
    def _int(v):
        return int(v) if v is not None else 0

    return {
        h: {
            'resolved':    _int(row[f'r{h}']),
            'proximity':   _flt(row[f'a{h}']),
            'direction':   _flt(row[f'd{h}']),
        }
        for h in ('1w', '1m', '6m', '1y')
    }


def _worst_momentum_bucket(cur, symbol: str, mv: str, from_date: Optional[str], to_date: Optional[str]) -> Optional[dict]:
    """Find the 30d-momentum bucket with the lowest 6m direction accuracy.
    Returns None if no bucket has >=3 samples (too noisy)."""
    date_clause, date_params = _date_clause('pr.', from_date, to_date)
    cur.execute(f"""
        SELECT
          CASE
            WHEN pd.stock_return_30d >  0.05 THEN 'up'
            WHEN pd.stock_return_30d < -0.05 THEN 'down'
            ELSE 'flat'
          END AS bucket,
          COUNT(*) AS n,
          AVG(pr.direction_correct_6m) * 100 AS dir6m
        FROM prediction_records pr
        JOIN prediction_details pd ON pd.prediction_record_id = pr.id
        WHERE pr.symbol = %s AND pr.model_version = %s{date_clause}
        GROUP BY bucket
        HAVING n >= 3 AND dir6m IS NOT NULL
        ORDER BY dir6m ASC
        LIMIT 1
    """, (symbol, mv, *date_params))
    row = cur.fetchone()
    if not row:
        return None
    return {'bucket': row['bucket'], 'n': int(row['n']), 'direction_6m': round(float(row['dir6m']), 1)}


def _prune_horizons(stats: dict) -> dict:
    """Drop horizons with zero resolved predictions — they're noise in the
    prompt and inflate token count for no signal."""
    return {h: v for h, v in stats.items() if v.get('resolved', 0) > 0}


def _build_summary(cur, symbols: list, mv: str, from_date: Optional[str], to_date: Optional[str],
                   include_prior_week: bool) -> dict:
    """Compact JSON the LLM will consume. Aggressively prunes empty blocks so
    the prompt stays inside llama3.2's practical context budget."""
    summary: dict = {'model_version': mv, 'window': {'from': from_date, 'to': to_date}, 'tickers': []}

    prior_from = prior_to = None
    if include_prior_week:
        today = date.today()
        prior_to   = (today - timedelta(days=7)).isoformat()
        prior_from = (today - timedelta(days=14)).isoformat()

    for s in symbols:
        current = _prune_horizons(_horizon_stats(cur, s, mv, from_date, to_date))
        if not current:
            # Nothing resolved for this ticker in the window — skip it entirely
            # rather than send an empty entry.
            continue
        entry: dict = {'symbol': s, 'current': current}

        worst = _worst_momentum_bucket(cur, s, mv, from_date, to_date)
        if worst:
            entry['worst_regime'] = worst

        if include_prior_week:
            prior = _prune_horizons(_horizon_stats(cur, s, mv, prior_from, prior_to))
            if prior:
                entry['prior_week'] = prior

        summary['tickers'].append(entry)

    return summary


def _write_narrative(text: str) -> str:
    """Write narrative to reports/backtest_narrative_YYYY-MM-DD.txt. Returns path."""
    os.makedirs(REPORTS_DIR, exist_ok=True)
    path = os.path.join(REPORTS_DIR, f'backtest_narrative_{date.today().isoformat()}.txt')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(text.strip() + '\n')
    return os.path.normpath(path)


def run_narration(
    symbols: List[str],
    model_version: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    include_prior_week: bool = True,
) -> Optional[str]:
    """Callable entry point — same logic as the CLI main(), but returns the
    narrative text (or None on any skip/failure) instead of exiting the
    process. Intended for backtest_predictions.py to call at end-of-run.

    Behaves identically to CLI mode: does its own Ollama pre-flight, its own
    DB query, its own file write. Never raises — any exception path returns
    None so the caller can decide how to surface the skip.
    """
    symbols = [s.upper() for s in symbols]

    if not is_ollama_enabled():
        print('[narrate] OLLAMA_ENABLED=false — skipping narrative generation', file=sys.stderr)
        return None
    if not check_ollama_reachable():
        print('[narrate] Ollama daemon unreachable — skipping narrative generation', file=sys.stderr)
        return None

    conn = connect()
    cur = conn.cursor(dictionary=True)
    try:
        summary = _build_summary(cur, symbols, model_version, from_date, to_date, include_prior_week)
    finally:
        cur.close(); conn.close()

    if not summary['tickers']:
        print(f'[narrate] No resolved predictions for {symbols} at model_version={model_version} — skipping',
              file=sys.stderr)
        return None

    try:
        prompt = load_prompt('backtest_narrative', summary_json=json.dumps(summary, indent=2))
    except FileNotFoundError as exc:
        print(f'[narrate] Prompt template missing: {exc}', file=sys.stderr)
        return None

    raw = generate(
        prompt,
        timeout_ms=NARRATIVE_TIMEOUT_MS,
        temperature=NARRATIVE_TEMPERATURE,
        num_predict=NARRATIVE_NUM_PREDICT,
    )
    if raw is None:
        print('[narrate] Ollama returned no output (timeout / non-2xx / bad response) — skipping',
              file=sys.stderr)
        return None

    text = raw.strip().strip('"').strip("'")
    # Strip trivial preamble the LLM sometimes adds despite the prompt.
    for prefix in ('Summary:', 'Narrative:', 'Here is', 'Here\'s'):
        if text.startswith(prefix):
            text = text.split(':', 1)[-1].strip() or text[len(prefix):].strip()

    path = _write_narrative(text)
    print(f'[narrate] Wrote narrative to {path} ({len(text)} chars)', file=sys.stderr)
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('symbols', nargs='+', help='One or more ticker symbols')
    ap.add_argument('--model-version', default='v5')
    ap.add_argument('--from-date', dest='from_date', help='YYYY-MM-DD (inclusive lower bound)')
    ap.add_argument('--to-date',   dest='to_date',   help='YYYY-MM-DD (inclusive upper bound)')
    ap.add_argument('--no-prior-week', dest='include_prior_week', action='store_false',
                    default=True, help='Skip the prior-week comparison block')
    args = ap.parse_args()
    run_narration(args.symbols, args.model_version, args.from_date, args.to_date,
                  args.include_prior_week)
    # Always exit 0 — Ollama failures are non-fatal for downstream cron
    return 0


if __name__ == '__main__':
    sys.exit(main())
