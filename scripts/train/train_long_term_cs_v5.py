#!/usr/bin/env python3
"""
train_long_term_cs_v5.py — CS long-term model retrain targeting green_v2 data.

Fork of train_long_term_cs_v2.py with three changes:
  1. Output paths → long_term_cs_v5.{keras,pkl,manifest.json}
  2. TRAIN_FEATURE_VERSION defaults to 'green_v2' (146 K resolved rows,
     2020-2024) because green_v3 has 0 resolved 6m/1y labels as of 2026-08.
  3. Baseline comparison prints v2 metrics instead of v1/v2_prev.

Everything else — architecture, loss, hyperparameters, regime weighting — is
identical to v2 so the only variable is the training data source.

USAGE:
  python3 scripts/train_long_term_cs_v5.py
  python3 scripts/train_long_term_cs_v5.py --lambda-consistency 1.0 --huber-delta 0.5
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
from sklearn.preprocessing import StandardScaler
import joblib

import mysql.connector

os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
import tensorflow as tf
from tensorflow.keras import layers, Model, Input
from tensorflow.keras.optimizers import Adam
from tensorflow.keras.callbacks import EarlyStopping

from ranker_features import FEATURE_COLUMNS as CS_FEATURE_COLUMNS, FEATURE_SET_VERSION
from keras_wrapper import KerasModelWrapper, get_tanh_scaled_layer

REGIME_INTERACTION_COLS = [
    'VIX_x_HYG_LQD',
    'VIX_x_CurveSlope',
    'HYG_x_RS_SPY',
    'VIX_x_HistVol60',
]
ALL_FEATURE_COLUMNS = CS_FEATURE_COLUMNS + REGIME_INTERACTION_COLS


def add_regime_interactions(df: pd.DataFrame) -> pd.DataFrame:
    df['VIX_x_HYG_LQD']   = df['VIX'] * df['HYG_LQD_Ratio']
    df['VIX_x_CurveSlope'] = df['VIX'] * df['CurveSlope_10M3M']
    df['HYG_x_RS_SPY']     = df['HYG_LQD_Ratio'] * df['RS_vs_SPY_20d']
    df['VIX_x_HistVol60']  = df['VIX'] * df['HistVol_60']
    df[REGIME_INTERACTION_COLS] = (
        df[REGIME_INTERACTION_COLS]
        .replace([np.inf, -np.inf], 0.0)
        .fillna(0.0)
    )
    return df


def compute_regime_weights(df: pd.DataFrame, max_weight: float = 4.0) -> np.ndarray:
    vix     = df['VIX'].values.astype(np.float32)
    hyg_lqd = df['HYG_LQD_Ratio'].values.astype(np.float32)

    vix_z   =  (vix     - vix.mean())     / (vix.std()     + 1e-8)
    hyg_z   = -(hyg_lqd - hyg_lqd.mean()) / (hyg_lqd.std() + 1e-8)

    stress  = 0.6 * vix_z + 0.4 * hyg_z
    weights = 1.0 + np.clip(stress, 0.0, None)
    weights = np.clip(weights, 1.0, max_weight)
    weights = weights / weights.mean()
    return weights.astype(np.float32)


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

KERAS_PATH    = MODELS_DIR / 'long_term_cs_v5.keras'
WRAPPER_PATH  = MODELS_DIR / 'long_term_cs_v5.pkl'
MANIFEST_PATH = MODELS_DIR / 'long_term_cs_v5_manifest.json'


def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def load_dataset(conn):
    cur = conn.cursor(dictionary=True)
    # Default to green_v2 — the only version with resolved 6m/1y labels as of
    # 2026-08. Override via TRAIN_FEATURE_VERSION env var if needed.
    _train_version = os.getenv('TRAIN_FEATURE_VERSION', 'green_v2')
    print(f"[dataset] filtering to feature_set_version = {_train_version!r}", file=sys.stderr)
    cur.execute("""
        SELECT snapshot_date, ticker, features_json,
               forward_return_126d, forward_return_252d
        FROM ranking_training_snapshots
        WHERE forward_return_126d IS NOT NULL
          AND forward_return_252d IS NOT NULL
          AND feature_set_version = %s
        ORDER BY snapshot_date, ticker
    """, (_train_version,))
    rows = cur.fetchall()
    if not rows:
        print("ERROR: no resolved long-term rows. Run extend_long_term_labels.py first.", file=sys.stderr)
        sys.exit(1)
    records = []
    for r in rows:
        fj = r['features_json']
        if isinstance(fj, str):
            fj = json.loads(fj)
        rec = {'snapshot_date': r['snapshot_date'], 'ticker': r['ticker'],
               'return_126d': float(r['forward_return_126d']),
               'return_252d': float(r['forward_return_252d'])}
        for col in CS_FEATURE_COLUMNS:
            v = fj.get(col)
            rec[col] = 0.0 if v is None else float(v)
        records.append(rec)
    df = pd.DataFrame(records)
    df[CS_FEATURE_COLUMNS] = df[CS_FEATURE_COLUMNS].replace([np.inf, -np.inf], 0.0).fillna(0.0)
    return df


def time_split(df, val_frac):
    unique_dates = sorted(df['snapshot_date'].unique())
    cutoff_idx = int(len(unique_dates) * (1 - val_frac))
    cutoff_date = unique_dates[cutoff_idx]
    train = df[df['snapshot_date'] <  cutoff_date].reset_index(drop=True)
    val   = df[df['snapshot_date'] >= cutoff_date].reset_index(drop=True)
    return train, val


def make_joint_loss(lambda_consistency: float, huber_delta: float, ratio_threshold: float,
                    lambda_opposite_sign: float = 1.0):
    huber = tf.keras.losses.Huber(delta=huber_delta)

    def joint_loss(y_true, y_pred):
        reg_loss = huber(y_true, y_pred)

        p_6m = y_pred[:, 0]
        p_1y = y_pred[:, 1]
        abs_6m = tf.abs(p_6m)
        abs_1y = tf.abs(p_1y)
        same_sign = tf.cast(p_6m * p_1y > 0.0, tf.float32)
        overshoot = tf.nn.relu(abs_6m - ratio_threshold * abs_1y)
        consistency_loss = tf.reduce_mean(same_sign * tf.square(overshoot))

        opposite_sign_penalty = tf.reduce_mean(tf.nn.relu(-p_6m * p_1y))

        return reg_loss + lambda_consistency * consistency_loss + lambda_opposite_sign * opposite_sign_penalty

    return joint_loss


def build_model(n_features, hidden, cap_6m, cap_1y, seed):
    tf.keras.utils.set_random_seed(seed)
    inputs = Input(shape=(n_features,), name='features')
    x = inputs
    for h in hidden:
        x = layers.Dense(h, activation='relu')(x)
    raw = layers.Dense(2, name='raw_returns')(x)
    TanhScaled = get_tanh_scaled_layer()
    out = TanhScaled([cap_6m, cap_1y], name='bounded_returns')(raw)
    return Model(inputs, out)


def consistency_rate(pred, ratio_threshold):
    p6, p1 = pred[:, 0], pred[:, 1]
    same = np.sign(p6) == np.sign(p1)
    nonzero = (p6 != 0) & (p1 != 0)
    mask = same & nonzero
    if mask.sum() == 0:
        return 0.0, 0.0
    overshoot = np.abs(p6[mask]) - ratio_threshold * np.abs(p1[mask])
    trips = (overshoot > 0).sum()
    mean_overshoot = overshoot[overshoot > 0].mean() if trips > 0 else 0.0
    return trips / mask.sum(), float(mean_overshoot)


def opposite_sign_rate(pred, floor=0.05):
    p6, p1 = pred[:, 0], pred[:, 1]
    material = (np.abs(p6) > floor) & (np.abs(p1) > floor)
    if material.sum() == 0:
        return 0.0, 0.0
    p6_m, p1_m = p6[material], p1[material]
    opp = np.sign(p6_m) != np.sign(p1_m)
    rate = float(opp.sum() / material.sum())
    mean_mag = float((np.abs(p6_m[opp]) + np.abs(p1_m[opp])).mean() / 2) if opp.sum() > 0 else 0.0
    return rate, mean_mag


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--val-frac', type=float, default=0.2)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--hidden', type=str, default='256,128,64')
    ap.add_argument('--epochs', type=int, default=200)
    ap.add_argument('--batch-size', type=int, default=256)
    ap.add_argument('--huber-delta', type=float, default=0.5)
    ap.add_argument('--lambda-consistency', type=float, default=1.0)
    ap.add_argument('--lambda-opposite-sign', type=float, default=1.0)
    ap.add_argument('--ratio-threshold', type=float, default=1.5)
    ap.add_argument('--cap-6m', type=float, default=0.7)
    ap.add_argument('--cap-1y', type=float, default=1.0)
    ap.add_argument('--regime-weight-max', type=float, default=4.0)
    args = ap.parse_args()

    print(f"[{datetime.now().isoformat()}] Loading dataset...")
    conn = get_db(); df = load_dataset(conn); conn.close()
    df = add_regime_interactions(df)
    n_total = len(df); n_tickers = df['ticker'].nunique()
    print(f"  rows: {n_total}  tickers: {n_tickers}  "
          f"date range: {df['snapshot_date'].min()} → {df['snapshot_date'].max()}")
    print(f"  features: {len(ALL_FEATURE_COLUMNS)} "
          f"({len(CS_FEATURE_COLUMNS)} base + {len(REGIME_INTERACTION_COLS)} regime interactions)")

    train_df, val_df = time_split(df, args.val_frac)
    print(f"  train: {len(train_df)}  val: {len(val_df)} "
          f"(cutoff: {val_df['snapshot_date'].min() if len(val_df) else 'n/a'})")

    X_train = train_df[ALL_FEATURE_COLUMNS].values.astype(np.float32)
    X_val   = val_df[ALL_FEATURE_COLUMNS].values.astype(np.float32)
    Y_train = train_df[['return_126d', 'return_252d']].values.astype(np.float32)
    Y_val   = val_df[['return_126d', 'return_252d']].values.astype(np.float32)

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_val_s   = scaler.transform(X_val)

    hidden = tuple(int(h) for h in args.hidden.split(','))
    print(f"\n[{datetime.now().isoformat()}] Building Keras model "
          f"hidden={hidden} huber_delta={args.huber_delta} "
          f"λ_consistency={args.lambda_consistency} λ_opposite_sign={args.lambda_opposite_sign} "
          f"ratio_threshold={args.ratio_threshold} cap_6m={args.cap_6m} cap_1y={args.cap_1y}")
    model = build_model(len(ALL_FEATURE_COLUMNS), hidden, args.cap_6m, args.cap_1y, args.seed)
    loss_fn = make_joint_loss(args.lambda_consistency, args.huber_delta, args.ratio_threshold,
                              args.lambda_opposite_sign)
    model.compile(optimizer=Adam(learning_rate=1e-3), loss=loss_fn)

    es = EarlyStopping(monitor='val_loss', patience=15, restore_best_weights=True, verbose=0)

    train_weights = None
    if args.regime_weight_max > 1.0:
        train_weights = compute_regime_weights(train_df, max_weight=args.regime_weight_max)
        stressed = (train_weights > 1.5).sum()
        print(f"  regime weights: max={train_weights.max():.2f}  "
              f"stressed (>1.5×) samples={stressed} ({100*stressed/len(train_weights):.1f}%)")

    print(f"\n[{datetime.now().isoformat()}] Training (epochs={args.epochs}, batch={args.batch_size}"
          f", regime_weight_max={args.regime_weight_max})...")
    hist = model.fit(
        X_train_s, Y_train,
        sample_weight=train_weights,
        validation_split=0.1,
        epochs=args.epochs, batch_size=args.batch_size,
        callbacks=[es], verbose=2,
    )
    print(f"  stopped at epoch {len(hist.history['loss'])}, "
          f"train={hist.history['loss'][-1]:.6f} val={hist.history['val_loss'][-1]:.6f}")

    pred_val = np.asarray(model.predict(X_val_s, verbose=0))
    print(f"\n[{datetime.now().isoformat()}] Validation metrics:")
    metrics = {}
    for i, h in enumerate(['return_126d', 'return_252d']):
        mae = mean_absolute_error(Y_val[:, i], pred_val[:, i])
        r2  = r2_score(Y_val[:, i], pred_val[:, i])
        dir_correct = float(np.mean(np.sign(pred_val[:, i]) == np.sign(Y_val[:, i])))
        print(f"  {h}: mae={mae:.4f}  r²={r2:.4f}  direction-correct={100*dir_correct:.1f}%")
        metrics[f"{h}_mae"] = float(mae)
        metrics[f"{h}_dir_correct"] = dir_correct

    per_ticker_cv_mape: dict[str, float] = {}
    per_ticker_n:       dict[str, int]   = {}
    if len(val_df) > 0:
        val_tickers = val_df['ticker'].values
        abs_err_6m = np.abs(pred_val[:, 0] - Y_val[:, 0])
        for tk in np.unique(val_tickers):
            mask = val_tickers == tk
            if int(mask.sum()) < 5:
                continue
            per_ticker_cv_mape[str(tk)] = float(np.mean(abs_err_6m[mask]) * 100.0)
            per_ticker_n[str(tk)]       = int(mask.sum())
    print(f"  per-ticker cv_mape: {len(per_ticker_cv_mape)} tickers with n≥5 val samples")

    incons_rate, mean_overshoot = consistency_rate(pred_val, args.ratio_threshold)
    print(f"  inconsistency-rate (|6m|>{args.ratio_threshold}×|1y|, same-sign): {100*incons_rate:.2f}%")
    print(f"  mean overshoot (when fired, units of return): {mean_overshoot:.4f}")
    metrics['inconsistency_rate'] = incons_rate
    metrics['mean_overshoot_when_fired'] = mean_overshoot

    opp_rate, mean_opp_mag = opposite_sign_rate(pred_val)
    print(f"  opposite-sign-rate (|6m|>5% and |1y|>5%, opposite signs): {100*opp_rate:.2f}%")
    print(f"  mean magnitude when fired: {mean_opp_mag:.4f}")
    metrics['opposite_sign_rate'] = opp_rate
    metrics['mean_opposite_magnitude'] = mean_opp_mag

    # Compare v5 against the current production v2 model on the same val set
    v2_path = MODELS_DIR / 'long_term_cs_v2.pkl'
    if v2_path.exists():
        try:
            v2 = joblib.load(v2_path)
            # v2 uses a KerasModelWrapper — need to use its scaler + model
            v2_x = v2['scaler'].transform(X_val)
            v2_pred = np.asarray(v2['model'].predict(v2_x))
            v2_opp, v2_opp_mag = opposite_sign_rate(v2_pred)
            v2_incons, v2_overshoot = consistency_rate(v2_pred, args.ratio_threshold)
            print(f"  [v2 baseline] inconsistency-rate: {100*v2_incons:.2f}%  "
                  f"opposite-sign-rate: {100*v2_opp:.2f}%")
            metrics['v2_baseline_inconsistency_rate'] = v2_incons
            metrics['v2_baseline_opposite_sign_rate'] = v2_opp
        except Exception as e:
            print(f"  [v2 baseline load failed: {e}]")

    print(f"  pred range 6m: [{pred_val[:,0].min():+.3f}, {pred_val[:,0].max():+.3f}]")
    print(f"  pred range 1y: [{pred_val[:,1].min():+.3f}, {pred_val[:,1].max():+.3f}]")
    metrics['pred_range_6m'] = [float(pred_val[:,0].min()), float(pred_val[:,0].max())]
    metrics['pred_range_1y'] = [float(pred_val[:,1].min()), float(pred_val[:,1].max())]

    model.save(KERAS_PATH)
    payload = {
        'model': KerasModelWrapper(str(KERAS_PATH)),
        'scaler': scaler,
        'feature_columns': ALL_FEATURE_COLUMNS,
        'feature_set_version': FEATURE_SET_VERSION,
        'target_columns': ['return_126d', 'return_252d'],
        'trained_at': datetime.now().isoformat(),
        'train_rows': len(train_df),
        'val_rows': len(val_df),
        'train_tickers': int(train_df['ticker'].nunique()),
        'framework': 'keras',
        'huber_delta': args.huber_delta,
        'lambda_consistency': args.lambda_consistency,
        'lambda_opposite_sign': args.lambda_opposite_sign,
        'ratio_threshold': args.ratio_threshold,
        'cap_6m': args.cap_6m,
        'cap_1y': args.cap_1y,
        'regime_weight_max': args.regime_weight_max,
        'per_ticker_cv_mape':      per_ticker_cv_mape,
        'per_ticker_val_samples':  per_ticker_n,
    }
    joblib.dump(payload, WRAPPER_PATH)
    print(f"\n[saved] {KERAS_PATH}")
    print(f"[saved] {WRAPPER_PATH}")

    manifest = {
        'feature_columns': ALL_FEATURE_COLUMNS,
        'feature_set_version': FEATURE_SET_VERSION,
        'target_columns': ['return_126d', 'return_252d'],
        'framework': 'keras',
        'hidden_layers': list(hidden),
        'epochs_max': args.epochs,
        'batch_size': args.batch_size,
        'huber_delta': args.huber_delta,
        'lambda_consistency': args.lambda_consistency,
        'lambda_opposite_sign': args.lambda_opposite_sign,
        'ratio_threshold': args.ratio_threshold,
        'cap_6m': args.cap_6m,
        'cap_1y': args.cap_1y,
        'epochs_trained': len(hist.history['loss']),
        'final_train_loss': float(hist.history['loss'][-1]),
        'final_val_loss':   float(hist.history['val_loss'][-1]),
        'trained_at': datetime.now().isoformat(),
        'train_rows': len(train_df),
        'val_rows': len(val_df),
        'train_tickers': int(train_df['ticker'].nunique()),
        'val_metrics': metrics,
    }
    with open(MANIFEST_PATH, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f"[saved] {MANIFEST_PATH}")


if __name__ == '__main__':
    main()
