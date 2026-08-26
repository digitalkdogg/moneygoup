"""
Pooled + segmented backtest analysis for prediction_records.

Per-ticker direction accuracy (as shown in the UI backtest table) is
statistically unreliable at typical run counts (n~20 => stdev ~11pp under a
true coin flip). This script pools across the whole backtest universe to get
a real sample size, and breaks it down by horizon, market-cap bucket,
valuation bucket, model_version, and confidence decile (calibration check).

Usage:
    python scripts/aggregate_backtest_results.py [--model-version v3split] [--min-runs 5]
"""
import argparse
import math
import os
import sys

import mysql.connector
from dotenv import load_dotenv

load_dotenv()

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT = int(os.getenv('DB_PORT', '3306'))

HORIZONS = ['1w', '1m', '6m', '1y']


def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def wilson_ci(successes: int, n: int, z: float = 1.96):
    """95% Wilson score interval for a binomial proportion — more honest
    than a normal approximation at small n."""
    if n == 0:
        return (float('nan'), float('nan'))
    p = successes / n
    denom = 1 + z ** 2 / n
    center = (p + z ** 2 / (2 * n)) / denom
    half = (z * math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def market_cap_bucket(market_cap_bucket_value):
    # Already bucketed at snapshot time in prediction_details.market_cap_bucket
    # (see backtest_predictions.py:_bucket_market_cap) — just normalize None.
    return market_cap_bucket_value or 'unknown'


def valuation_bucket(pe_ratio):
    if pe_ratio is None or pe_ratio <= 0:
        return 'unknown'
    if pe_ratio < 15:
        return 'undervalued'
    if pe_ratio > 25:
        return 'overvalued'
    return 'fair_value'


def fetch_rows(conn, model_version: str | None):
    cols = ['pr.symbol', 'pr.model_version']
    for h in HORIZONS:
        cols += [f'pr.direction_correct_{h}', f'pr.resolved_{h}', f'pr.confidence_score_{h}']
    cols += ['pd.pe_ratio', 'pd.market_cap_bucket']

    query = f"""
        SELECT {', '.join(cols)}
        FROM prediction_records pr
        LEFT JOIN prediction_details pd ON pd.prediction_record_id = pr.id
    """
    params = []
    if model_version:
        query += " WHERE pr.model_version = %s"
        params.append(model_version)

    cursor = conn.cursor(dictionary=True)
    cursor.execute(query, params)
    rows = cursor.fetchall()
    cursor.close()
    return rows


def summarize(label: str, rows: list, direction_correct_key: str, min_runs: int):
    """rows: list of direction_correct values (0/1), None already filtered out."""
    n = len(rows)
    if n < min_runs:
        return None
    successes = sum(1 for v in rows if v == 1)
    acc = successes / n
    lo, hi = wilson_ci(successes, n)
    return {
        'label': label, 'n': n, 'correct': successes,
        'accuracy': acc, 'ci_lo': lo, 'ci_hi': hi,
    }


def print_table(title: str, results: list):
    print(f"\n=== {title} ===")
    if not results:
        print("  (no groups met --min-runs threshold)")
        return
    print(f"  {'segment':<20} {'n':>6} {'dir_acc':>9} {'95% CI':>18}")
    for r in results:
        ci = f"[{r['ci_lo']*100:5.1f}, {r['ci_hi']*100:5.1f}]"
        print(f"  {r['label']:<20} {r['n']:>6} {r['accuracy']*100:>8.1f}% {ci:>18}")


def main():
    parser = argparse.ArgumentParser(description='Pooled/segmented backtest direction-accuracy analysis')
    parser.add_argument('--model-version', default=None, help='Filter to one model_version (default: all)')
    parser.add_argument('--min-runs', type=int, default=20, help='Minimum n to report a segment')
    parser.add_argument('--conf-bins', type=int, default=5, help='Number of confidence-calibration bins')
    args = parser.parse_args()

    conn = get_db()
    rows = fetch_rows(conn, args.model_version)
    conn.close()

    if not rows:
        print("No prediction_records rows found.", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(rows)} prediction_records rows"
          f"{f' (model_version={args.model_version})' if args.model_version else ' (all model_versions)'}.")

    # ── 1. Pooled direction accuracy per horizon, per model_version ──────────
    for mv in sorted(set(r['model_version'] for r in rows)):
        pooled = []
        for h in HORIZONS:
            vals = [
                r[f'direction_correct_{h}'] for r in rows
                if r['model_version'] == mv and r[f'resolved_{h}'] and r[f'direction_correct_{h}'] is not None
            ]
            s = summarize(h, vals, f'direction_correct_{h}', args.min_runs)
            if s:
                pooled.append(s)
        print_table(f"Pooled direction accuracy — model_version={mv}", pooled)

    # ── 2. Segmented by market-cap bucket, per horizon (using latest model_version if unfiltered) ──
    target_mv = args.model_version or max(set(r['model_version'] for r in rows),
                                           key=lambda mv: sum(1 for r in rows if r['model_version'] == mv))
    print(f"\n(Segments below use model_version={target_mv} — pass --model-version to pick a specific one)")

    for h in HORIZONS:
        segs = {}
        for r in rows:
            if r['model_version'] != target_mv:
                continue
            if not r[f'resolved_{h}'] or r[f'direction_correct_{h}'] is None:
                continue
            bucket = market_cap_bucket(r['market_cap_bucket'])
            segs.setdefault(bucket, []).append(r[f'direction_correct_{h}'])
        results = [
            s for b, vals in sorted(segs.items())
            if (s := summarize(b, vals, f'direction_correct_{h}', args.min_runs))
        ]
        print_table(f"[{h}] Direction accuracy by market-cap bucket", results)

    # ── 3. Segmented by valuation bucket, per horizon ─────────────────────────
    for h in HORIZONS:
        segs = {}
        for r in rows:
            if r['model_version'] != target_mv:
                continue
            if not r[f'resolved_{h}'] or r[f'direction_correct_{h}'] is None:
                continue
            bucket = valuation_bucket(r['pe_ratio'])
            segs.setdefault(bucket, []).append(r[f'direction_correct_{h}'])
        results = [
            s for b, vals in sorted(segs.items())
            if (s := summarize(b, vals, f'direction_correct_{h}', args.min_runs))
        ]
        print_table(f"[{h}] Direction accuracy by valuation bucket", results)

    # ── 4. Per-symbol outlier scan (flag symbols far from 50% at real n) ─────
    print(f"\n=== Per-symbol outliers (1w, |z| > 2.5 under H0: p=0.5) — model_version={target_mv} ===")
    sym_rows = {}
    for r in rows:
        if r['model_version'] != target_mv:
            continue
        if not r['resolved_1w'] or r['direction_correct_1w'] is None:
            continue
        sym_rows.setdefault(r['symbol'], []).append(r['direction_correct_1w'])

    outliers = []
    for sym, vals in sym_rows.items():
        n = len(vals)
        if n < args.min_runs:
            continue
        p = sum(vals) / n
        z = (p - 0.5) / math.sqrt(0.25 / n)
        if abs(z) > 2.5:
            outliers.append((sym, n, p, z))
    outliers.sort(key=lambda t: t[3])
    if outliers:
        for sym, n, p, z in outliers:
            print(f"  {sym:<8} n={n:<4} dir_acc={p*100:5.1f}%  z={z:+.2f}")
    else:
        print("  none")

    # ── 5. Confidence calibration — direction accuracy by confidence decile ──
    for h in HORIZONS:
        pairs = [
            (r[f'confidence_score_{h}'], r[f'direction_correct_{h}'])
            for r in rows
            if r['model_version'] == target_mv
            and r[f'resolved_{h}'] and r[f'direction_correct_{h}'] is not None
            and r[f'confidence_score_{h}'] is not None
        ]
        if len(pairs) < args.min_runs:
            continue
        pairs.sort(key=lambda t: t[0])
        n = len(pairs)
        bin_size = max(1, n // args.conf_bins)
        results = []
        for i in range(0, n, bin_size):
            chunk = pairs[i:i + bin_size]
            if not chunk:
                continue
            confs = [c for c, _ in chunk]
            dirs = [d for _, d in chunk]
            s = summarize(f"{min(confs):.0f}-{max(confs):.0f}", dirs, f'direction_correct_{h}', 1)
            if s:
                results.append(s)
        print_table(f"[{h}] Direction accuracy by confidence bin (low->high)", results)


if __name__ == '__main__':
    main()
