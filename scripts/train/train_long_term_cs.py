#!/usr/bin/env python3
"""
train_long_term_cs.py — train the cross-sectional long-term model.

Reads (snapshot_date, ticker, features_json, forward_return_63d,
forward_return_126d) rows from ranking_training_snapshots, time-splits
80/20 by date, trains an MLPRegressor with 2 output heads
([return_63d, return_126d]), and persists model + scaler + feature
manifest for predict_long_term.py to load.

Pre-req: scripts/extend_long_term_labels.py must have run to populate
the 63d / 126d label columns.

Outputs:
  - models/long_term_cs_v1.pkl              joblib pickle: dict with model + scaler + meta
  - models/long_term_cs_v1_manifest.json    feature column order + dataset metadata

USAGE:
  python3 scripts/train_long_term_cs.py
  python3 scripts/train_long_term_cs.py --val-frac 0.2 --seed 42
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
import joblib

import mysql.connector

# Reuse the ranker's GREEN feature column order — that's what's in
# features_json. Importing keeps the schemas in lock-step.
from ranker_features import FEATURE_COLUMNS as CS_FEATURE_COLUMNS, FEATURE_SET_VERSION

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
MODELS_DIR   = Path(PROJECT_ROOT) / 'models'
MODELS_DIR.mkdir(exist_ok=True)
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

MODEL_PATH    = MODELS_DIR / 'long_term_cs_v1.pkl'
MANIFEST_PATH = MODELS_DIR / 'long_term_cs_v1_manifest.json'


def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def load_dataset(conn) -> pd.DataFrame:
    """Pull resolved-label rows. Returns a DataFrame with one row per
    (snapshot_date, ticker), feature columns expanded inline."""
    cur = conn.cursor(dictionary=True)
    cur.execute("""
        SELECT snapshot_date, ticker, features_json,
               forward_return_63d, forward_return_126d, feature_set_version
        FROM ranking_training_snapshots
        WHERE forward_return_63d  IS NOT NULL
          AND forward_return_126d IS NOT NULL
        ORDER BY snapshot_date, ticker
    """)
    rows = cur.fetchall()
    if not rows:
        print("ERROR: no resolved long-term rows found. Run extend_long_term_labels.py first.",
              file=sys.stderr)
        sys.exit(1)

    # features_json comes back as a JSON string OR already-parsed dict
    # depending on mysql connector version.
    records = []
    for r in rows:
        fj = r['features_json']
        if isinstance(fj, str):
            fj = json.loads(fj)
        record = {'snapshot_date': r['snapshot_date'], 'ticker': r['ticker'],
                  'return_63d':  float(r['forward_return_63d']),
                  'return_126d': float(r['forward_return_126d'])}
        for col in CS_FEATURE_COLUMNS:
            v = fj.get(col)
            # Some features stored as None; treat as 0 (matches ranker behavior)
            record[col] = 0.0 if v is None else float(v)
        records.append(record)

    df = pd.DataFrame(records)
    # Sanitize: features_json may contain inf/-inf from rolling-window edge cases
    df[CS_FEATURE_COLUMNS] = df[CS_FEATURE_COLUMNS].replace(
        [np.inf, -np.inf], 0.0).fillna(0.0)
    return df


def time_split(df: pd.DataFrame, val_frac: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split chronologically — newest val_frac of unique dates go to validation."""
    unique_dates = sorted(df['snapshot_date'].unique())
    cutoff_idx = int(len(unique_dates) * (1 - val_frac))
    cutoff_date = unique_dates[cutoff_idx]
    train = df[df['snapshot_date'] < cutoff_date].reset_index(drop=True)
    val   = df[df['snapshot_date'] >= cutoff_date].reset_index(drop=True)
    return train, val


def main():
    ap = argparse.ArgumentParser(description="Train cross-sectional long-term model")
    ap.add_argument('--val-frac', type=float, default=0.2)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--hidden', type=str, default='256,128,64',
                    help="Comma-separated hidden layer sizes (default: 256,128,64)")
    ap.add_argument('--max-iter', type=int, default=200)
    args = ap.parse_args()

    print(f"[{datetime.now().isoformat()}] Loading dataset from MySQL...")
    conn = get_db()
    df = load_dataset(conn)
    conn.close()

    n_total   = len(df)
    n_tickers = df['ticker'].nunique()
    print(f"  rows: {n_total}  tickers: {n_tickers}  "
          f"date range: {df['snapshot_date'].min()} → {df['snapshot_date'].max()}")

    train_df, val_df = time_split(df, args.val_frac)
    print(f"  train: {len(train_df)}  val: {len(val_df)} "
          f"(cutoff: {val_df['snapshot_date'].min() if len(val_df) else 'n/a'})")

    X_train = train_df[CS_FEATURE_COLUMNS].values.astype(np.float32)
    X_val   = val_df[CS_FEATURE_COLUMNS].values.astype(np.float32)
    Y_train = train_df[['return_63d', 'return_126d']].values.astype(np.float32)
    Y_val   = val_df[['return_63d', 'return_126d']].values.astype(np.float32)

    # StandardScaler (not MinMax) so the cross-sectional model handles new
    # tickers whose features may fall outside the training percentile range.
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_val_s   = scaler.transform(X_val)

    hidden_layers = tuple(int(h) for h in args.hidden.split(','))
    print(f"\n[{datetime.now().isoformat()}] Training MLP {hidden_layers}, max_iter={args.max_iter}...")
    model = MLPRegressor(
        hidden_layer_sizes=hidden_layers,
        activation='relu',
        solver='adam',
        learning_rate_init=0.001,
        max_iter=args.max_iter,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=15,
        random_state=args.seed,
        verbose=False,
    )
    model.fit(X_train_s, Y_train)
    print(f"  converged at iter {model.n_iter_} (loss {model.loss_:.6f})")

    # ── Validation metrics ──────────────────────────────────────────────────
    pred_val = model.predict(X_val_s)
    for i, h in enumerate(['return_63d', 'return_126d']):
        mae = mean_absolute_error(Y_val[:, i], pred_val[:, i])
        r2  = r2_score(Y_val[:, i], pred_val[:, i])
        dir_correct = float(np.mean(np.sign(pred_val[:, i]) == np.sign(Y_val[:, i])))
        print(f"  val {h}: mae={mae:.4f}  r²={r2:.4f}  direction-correct={100*dir_correct:.1f}%")

    # Baseline: just predict 0 (assume flat) on val
    print(f"  baseline (predict 0): "
          f"return_63d  mae={np.mean(np.abs(Y_val[:, 0])):.4f}  "
          f"return_126d mae={np.mean(np.abs(Y_val[:, 1])):.4f}")

    # ── Persist ─────────────────────────────────────────────────────────────
    payload = {
        'model': model,
        'scaler': scaler,
        'feature_columns': CS_FEATURE_COLUMNS,
        'feature_set_version': FEATURE_SET_VERSION,
        'target_columns': ['return_63d', 'return_126d'],
        'trained_at': datetime.now().isoformat(),
        'train_rows': len(train_df),
        'val_rows': len(val_df),
        'train_tickers': int(train_df['ticker'].nunique()),
    }
    joblib.dump(payload, MODEL_PATH)
    print(f"\n[saved] {MODEL_PATH}")

    manifest = {
        'feature_columns': CS_FEATURE_COLUMNS,
        'feature_set_version': FEATURE_SET_VERSION,
        'target_columns': ['return_63d', 'return_126d'],
        'hidden_layers': list(hidden_layers),
        'max_iter': args.max_iter,
        'trained_at': datetime.now().isoformat(),
        'train_rows': len(train_df),
        'val_rows': len(val_df),
        'train_tickers': int(train_df['ticker'].nunique()),
        'val_metrics': {
            'return_63d_mae':  float(mean_absolute_error(Y_val[:, 0], pred_val[:, 0])),
            'return_126d_mae': float(mean_absolute_error(Y_val[:, 1], pred_val[:, 1])),
            'return_63d_dir_correct':  float(np.mean(np.sign(pred_val[:, 0]) == np.sign(Y_val[:, 0]))),
            'return_126d_dir_correct': float(np.mean(np.sign(pred_val[:, 1]) == np.sign(Y_val[:, 1]))),
        },
    }
    with open(MANIFEST_PATH, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f"[saved] {MANIFEST_PATH}")


if __name__ == '__main__':
    main()
