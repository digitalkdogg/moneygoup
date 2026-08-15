#!/usr/bin/env python3
"""
calibrate_confidence.py — Confidence score reliability analysis and calibration.

Pulls resolved prediction_records from the DB, buckets by predicted confidence
decile × horizon, computes empirical direction-accuracy per bucket (reliability
curve), and fits an isotonic regression calibrator per horizon.

Outputs:
  - Printed reliability tables (one per horizon)
  - models/confidence_calibration.json   isotonic calibration maps

Usage:
  python3 scripts/calibrate_confidence.py
  python3 scripts/calibrate_confidence.py --horizons 1w 1m
  python3 scripts/calibrate_confidence.py --n-buckets 10
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import mysql.connector
from dotenv import load_dotenv
from sklearn.isotonic import IsotonicRegression

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
MODELS_DIR   = Path(PROJECT_ROOT) / 'models'

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))


HORIZON_META = {
    '1w':  {'score_col': 'confidence_score_1w',  'dir_col': 'direction_correct_1w',  'resolved_col': 'resolved_1w'},
    '1m':  {'score_col': 'confidence_score_1m',  'dir_col': 'direction_correct_1m',  'resolved_col': 'resolved_1m'},
    '6m':  {'score_col': 'confidence_score_6m',  'dir_col': 'direction_correct_6m',  'resolved_col': 'resolved_6m'},
    '1y':  {'score_col': 'confidence_score_1y',  'dir_col': 'direction_correct_1y',  'resolved_col': 'resolved_1y'},
}


def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def load_horizon_data(conn, horizon: str) -> pd.DataFrame:
    meta = HORIZON_META[horizon]
    score_col   = meta['score_col']
    dir_col     = meta['dir_col']
    resolved_col = meta['resolved_col']

    cur = conn.cursor(dictionary=True)
    cur.execute(
        f"""SELECT {score_col} AS confidence, {dir_col} AS direction_correct
            FROM prediction_records
            WHERE {resolved_col} = 1
              AND {score_col} IS NOT NULL
              AND {dir_col} IS NOT NULL"""
    )
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows)


def reliability_curve(df: pd.DataFrame, n_buckets: int = 10):
    """Bucket by confidence decile, compute mean predicted confidence and empirical hit-rate."""
    df = df.copy()
    df['confidence'] = pd.to_numeric(df['confidence'], errors='coerce')
    df['direction_correct'] = pd.to_numeric(df['direction_correct'], errors='coerce')
    df = df.dropna()

    if len(df) < n_buckets * 2:
        return None, None, None

    df['bucket'] = pd.qcut(df['confidence'], q=n_buckets, labels=False, duplicates='drop')

    buckets = df.groupby('bucket').agg(
        mean_conf=('confidence', 'mean'),
        hit_rate=('direction_correct', 'mean'),
        count=('direction_correct', 'count'),
    ).reset_index()

    return buckets['mean_conf'].values, buckets['hit_rate'].values, buckets['count'].values


def brier_skill_score(conf: np.ndarray, outcomes: np.ndarray) -> float:
    """Brier Skill Score vs. climatological baseline (mean outcome rate)."""
    baseline = outcomes.mean()
    brier_model = np.mean((conf / 100.0 - outcomes) ** 2)
    brier_clim  = np.mean((baseline - outcomes) ** 2)
    if brier_clim == 0:
        return 0.0
    return float(1.0 - brier_model / brier_clim)


def fit_isotonic(mean_conf: np.ndarray, hit_rate: np.ndarray) -> IsotonicRegression:
    ir = IsotonicRegression(out_of_bounds='clip', increasing=True)
    ir.fit(mean_conf, hit_rate)
    return ir


def calibration_lookup_table(ir: IsotonicRegression, n_points: int = 101) -> dict:
    """Build a {raw_score: calibrated_score} lookup table at integer confidence values 0–100."""
    raw_scores = np.arange(0, 101, dtype=float)
    calibrated = ir.predict(raw_scores) * 100.0  # convert back to 0–100 scale
    return {int(r): round(float(c), 2) for r, c in zip(raw_scores, calibrated)}


def print_table(horizon: str, mean_conf: np.ndarray, hit_rate: np.ndarray, counts: np.ndarray):
    print(f"\n  {'Conf bucket':>12}  {'Empirical dir-acc':>18}  {'N':>6}")
    print(f"  {'-'*12}  {'-'*18}  {'-'*6}")
    for mc, hr, n in zip(mean_conf, hit_rate, counts):
        flag = '  ← below 50%!' if hr < 0.5 else ''
        print(f"  {mc:>11.1f}  {hr:>17.1%}  {n:>6,}{flag}")


def main():
    ap = argparse.ArgumentParser(description='Confidence calibration analysis')
    ap.add_argument('--horizons', nargs='+', choices=['1w', '1m', '6m', '1y'],
                    default=['1w', '1m', '6m', '1y'], help='Horizons to analyze')
    ap.add_argument('--n-buckets', type=int, default=10, help='Number of confidence decile buckets')
    args = ap.parse_args()

    conn = get_db()
    calibration = {}
    MODELS_DIR.mkdir(exist_ok=True)

    for horizon in args.horizons:
        print(f"\n{'='*60}")
        print(f"HORIZON: {horizon}")
        print(f"{'='*60}")

        df = load_horizon_data(conn, horizon)

        if len(df) < 20:
            print(f"  Insufficient data ({len(df)} rows) — skipping.")
            continue

        print(f"  Loaded {len(df):,} resolved predictions")

        mean_conf, hit_rate, counts = reliability_curve(df, n_buckets=args.n_buckets)
        if mean_conf is None:
            print("  Could not compute reliability curve — too few rows per bucket.")
            continue

        print_table(horizon, mean_conf, hit_rate, counts)

        # Brier skill score using raw confidence/100 as predicted probability
        conf_arr = pd.to_numeric(df['confidence'], errors='coerce').dropna().values
        dir_arr  = pd.to_numeric(df['direction_correct'], errors='coerce').dropna().values
        min_len  = min(len(conf_arr), len(dir_arr))
        bss = brier_skill_score(conf_arr[:min_len], dir_arr[:min_len])

        calibrated_flag = '✅ well-calibrated' if bss > 0.05 else '⚠️  MISCALIBRATED'
        print(f"\n  Brier Skill Score: {bss:.4f}  → {calibrated_flag}")

        # Isotonic regression calibrator
        ir = fit_isotonic(mean_conf, hit_rate)
        lookup = calibration_lookup_table(ir)
        calibration[horizon] = lookup
        print(f"  Isotonic calibrator fitted ({args.n_buckets} control points)")

        # Show sample calibration adjustments
        for sample_raw in [40, 55, 65, 75, 85, 95]:
            if sample_raw in lookup:
                print(f"    raw={sample_raw} → calibrated={lookup[sample_raw]:.1f}%  (empirical dir-acc)")

    out_path = MODELS_DIR / 'confidence_calibration.json'
    out_path.write_text(json.dumps(calibration, indent=2))
    print(f"\n[calibrate_confidence] Saved → {out_path}")
    print("[calibrate_confidence] Done.")

    conn.close()


if __name__ == '__main__':
    main()
