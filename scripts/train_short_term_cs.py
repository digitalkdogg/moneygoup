#!/usr/bin/env python3
"""
train_short_term_cs.py — Cross-sectional short-term (1w/1m) model.

Pulls feature snapshots from ranking_training_snapshots (feature_set_version
= 'green_v3') and computes 5-day and 21-day forward returns via self-join on
adjacent weekly snapshots for the same ticker.  Trains a single MLPRegressor
across all tickers so the live inference path in predict_short_term.py can
skip per-ticker .fit() entirely.

Outputs (saved to models/):
  short_term_cs_v1.pkl   joblib dict: model, scaler, feature_columns, trained_at, metrics

Activation:
  Set ST_CS_MODEL_VERSION=v1 in .env.local (or .env.production) and restart
  the prediction service.  predict_short_term.py falls back to per-ticker
  training when the env var is absent or the artifact is missing.

Usage:
    python3 scripts/train_short_term_cs.py
    python3 scripts/train_short_term_cs.py --version v2 --min-rows 30000
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler

import mysql.connector
import joblib

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
MODELS_DIR   = Path(PROJECT_ROOT) / 'models'
MODELS_DIR.mkdir(exist_ok=True)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

# Features to extract from features_json — intersection with what the
# per-ticker path uses (SHORT_TERM_FEATURES from predict_core).  Subset
# to what's reliably present in green_v3 snapshots.
ST_FEATURE_COLUMNS = [
    'Open', 'High', 'Low', 'Close', 'Volume',
    'MACD', 'MACD_Signal',
    'BB_Upper', 'BB_Lower', 'BB_Mid',
    'RSI_14',
    'STOCH_K', 'STOCH_D',
    'ATR_14',
    'SMA_20', 'EMA_50',
    'HistVol_30',
    'Unprofitable_Flag',
    'PE_LogRatio_vs_Sector', 'PS_LogRatio_vs_Sector', 'FCF_Yield_vs_Sector',
    'HiRatio_52w', 'LoRatio_52w',
    'FiftyTwoWeek_PosRatio',
    'Close_lag_5', 'Close_lag_10', 'Close_lag_20',
    'Volume_lag_5',
    'ROC_5d', 'ROC_20d',
    'Return_1d', 'Return_5d', 'Return_20d',
    'PriceToHigh_20d', 'PriceToLow_20d', 'PriceToHigh_5d',
    'VolumePriceTrend',
    'EMA_Slope_10', 'EMA_Slope_20',
    'RollingMean_20d', 'RollingStd_20d',
    'RollingSkew_20d', 'RollingSharpe_20d',
    # Macro context (present in green_v3)
    'VIX', 'VIX_20d_Avg', 'VIX_RealVol_Ratio',
    'Treasury10Y', 'Treasury3M', 'CurveSlope_10M3M',
    'HYG_LQD_Ratio', 'HYG_Mom_20d', 'LQD_Mom_20d',
    'DXY_Level', 'DXY_Return_20d',
]


def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def load_dataset(conn, feature_set_version: str = 'green_v3') -> pd.DataFrame:
    """
    Load ranking_training_snapshots rows and self-join to compute
    5-day and 20-day forward returns.

    The snapshots are weekly, so the 'next' snapshot for a ticker is
    ~7 calendar days later.  We treat the weekly horizon_days=20 stored
    forward_return as the 1m (≈21 trading-day) target.  For the 5-day
    target we join each row to the nearest next-week snapshot of the
    same ticker and compute return from the Close prices.
    """
    print(f'[train_short_term_cs] Loading snapshots (feature_set_version={feature_set_version})...')
    cur = conn.cursor(dictionary=True)
    cur.execute(
        '''SELECT id, snapshot_date, ticker, features_json, forward_return
           FROM ranking_training_snapshots
           WHERE feature_set_version = %s
           ORDER BY ticker, snapshot_date''',
        (feature_set_version,)
    )
    rows = cur.fetchall()
    print(f'  Loaded {len(rows):,} raw rows from {len(set(r["ticker"] for r in rows)):,} tickers.')

    # Parse features_json → flat dict per row.
    records = []
    for r in rows:
        try:
            f = json.loads(r['features_json']) if isinstance(r['features_json'], str) else r['features_json']
        except Exception:
            continue
        rec = {
            'ticker':        r['ticker'],
            'snapshot_date': r['snapshot_date'],
            'return_21d':    r['forward_return'],  # horizon_days=20 ≈ 1 month
        }
        for col in ST_FEATURE_COLUMNS:
            v = f.get(col)
            rec[col] = float(v) if v is not None else 0.0
        records.append(rec)

    df = pd.DataFrame(records)
    df['snapshot_date'] = pd.to_datetime(df['snapshot_date'])
    df.sort_values(['ticker', 'snapshot_date'], inplace=True)
    df.reset_index(drop=True, inplace=True)

    # ── Compute 5d forward return via next-week snapshot ─────────────────────
    # Shift Close within each ticker group to get the next snapshot's price.
    df['next_close'] = df.groupby('ticker')['Close'].shift(-1)
    df['return_5d'] = (df['next_close'] - df['Close']) / (df['Close'].abs() + 1e-9)

    # Drop rows missing either target or price = 0.
    df = df.dropna(subset=['return_5d', 'return_21d'])
    df = df[df['Close'] > 0]
    # Clip extreme returns: ±100% for 5d, ±200% for 21d.
    df['return_5d']  = df['return_5d'].clip(-1.0, 1.0)
    df['return_21d'] = df['return_21d'].clip(-2.0, 2.0)

    print(f'  After filtering: {len(df):,} rows.')
    return df


def build_model(seed: int = 42) -> MLPRegressor:
    return MLPRegressor(
        hidden_layer_sizes=(96, 48, 24),
        activation='relu',
        solver='adam',
        learning_rate_init=0.001,
        max_iter=200,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=10,
        random_state=seed,
    )


def main():
    parser = argparse.ArgumentParser(description='Train cross-sectional short-term model')
    parser.add_argument('--version', default='v1', help='Model version tag for the output filename')
    parser.add_argument('--feature-set', default='green_v3', help='Feature set version to pull from DB')
    parser.add_argument('--min-rows', type=int, default=5000,
                        help='Abort if training set is smaller than this (sanity check)')
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()

    wrapper_path  = MODELS_DIR / f'short_term_cs_{args.version}.pkl'

    print(f'[train_short_term_cs] Output: {wrapper_path}')

    conn = get_db()
    df   = load_dataset(conn, feature_set_version=args.feature_set)
    conn.close()

    if len(df) < args.min_rows:
        print(f'ERROR: only {len(df)} rows — need {args.min_rows}. Aborting.', file=sys.stderr)
        sys.exit(1)

    X = df[ST_FEATURE_COLUMNS].values.astype(np.float32)
    Y = df[['return_5d', 'return_21d']].values.astype(np.float32)

    # Replace any remaining NaN/inf that slipped through.
    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
    Y = np.nan_to_num(Y, nan=0.0, posinf=0.0, neginf=0.0)

    # Train/validation split (80/20 chronological).
    split = int(len(X) * 0.8)
    X_train, X_val = X[:split], X[split:]
    Y_train, Y_val = Y[:split], Y[split:]

    print(f'  Train: {len(X_train):,}  Val: {len(X_val):,}')

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_val_s   = scaler.transform(X_val)

    print('[train_short_term_cs] Training MLPRegressor(96, 48, 24)...')
    model = build_model(seed=args.seed)
    model.fit(X_train_s, Y_train)

    # ── Evaluation ────────────────────────────────────────────────────────────
    Y_pred = model.predict(X_val_s)
    mae_5d  = float(mean_absolute_error(Y_val[:, 0], Y_pred[:, 0]))
    mae_21d = float(mean_absolute_error(Y_val[:, 1], Y_pred[:, 1]))
    r2_5d   = float(r2_score(Y_val[:, 0], Y_pred[:, 0]))
    r2_21d  = float(r2_score(Y_val[:, 1], Y_pred[:, 1]))

    # Direction accuracy (fraction of samples where sign matches).
    dir_5d  = float(np.mean(np.sign(Y_pred[:, 0]) == np.sign(Y_val[:, 0])))
    dir_21d = float(np.mean(np.sign(Y_pred[:, 1]) == np.sign(Y_val[:, 1])))

    metrics = {
        'mae_return_5d': mae_5d,
        'mae_return_21d': mae_21d,
        'r2_return_5d': r2_5d,
        'r2_return_21d': r2_21d,
        'direction_accuracy_5d': dir_5d,
        'direction_accuracy_21d': dir_21d,
        'n_train': len(X_train),
        'n_val': len(X_val),
    }

    print(f'  MAE 5d={mae_5d:.4f}  21d={mae_21d:.4f}')
    print(f'  R²  5d={r2_5d:.3f}   21d={r2_21d:.3f}')
    print(f'  Dir 5d={dir_5d:.1%}  21d={dir_21d:.1%}')

    payload = {
        'model':           model,
        'scaler':          scaler,
        'feature_columns': ST_FEATURE_COLUMNS,
        'version':         args.version,
        'feature_set':     args.feature_set,
        'trained_at':      datetime.utcnow().isoformat(),
        'metrics':         metrics,
    }

    joblib.dump(payload, str(wrapper_path))
    print(f'[train_short_term_cs] Saved → {wrapper_path}')
    print('[train_short_term_cs] Done.')


if __name__ == '__main__':
    main()
