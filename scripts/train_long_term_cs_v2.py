#!/usr/bin/env python3
"""
train_long_term_cs_v2.py — CS long-term model with joint 6m/1y consistency loss.

Differences vs v1 (sklearn MLPRegressor with MSE):
  * Backend: Keras/TF (sklearn doesn't expose loss customization)
  * Standard error term: Huber loss (delta=0.5) instead of MSE — bounded
    gradient contribution from outlier returns (RGTI +6629%, BESS +14400%)
  * Joint consistency penalty: when 6m and 1y predictions are same-sign and
    |pred_6m| > 1.5 × |pred_1y|, add λ × (|pred_6m| - 1.5 × |pred_1y|)² to the
    loss. Pushes the two heads to agree on direction-and-magnitude during
    training rather than relying on _sanitize_predictions to catch divergence
    at inference time.
  * No tanh bound (let predictions stay continuous; the joint penalty
    pulls extreme 6m values down naturally during training).

Outputs:
  models/long_term_cs_v2.keras           keras model (weights + arch)
  models/long_term_cs_v2.pkl             joblib payload: wrapper + scaler + meta
  models/long_term_cs_v2_manifest.json   metrics + hyperparams

USAGE:
  python3 scripts/train_long_term_cs_v2.py
  python3 scripts/train_long_term_cs_v2.py --lambda-consistency 1.0 --huber-delta 0.5
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

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
MODELS_DIR   = Path(PROJECT_ROOT) / 'models'
MODELS_DIR.mkdir(exist_ok=True)
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

KERAS_PATH    = MODELS_DIR / 'long_term_cs_v2.keras'
WRAPPER_PATH  = MODELS_DIR / 'long_term_cs_v2.pkl'
MANIFEST_PATH = MODELS_DIR / 'long_term_cs_v2_manifest.json'


def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def load_dataset(conn):
    cur = conn.cursor(dictionary=True)
    # Training-data version — configurable via TRAIN_FEATURE_VERSION env var
    # so we can experiment with data mixes without editing code. Defaults to
    # the current FEATURE_SET_VERSION, but can be set to 'green_v1' to train
    # on the pre-fundamentals-features data (Option C: recover july_v1 accuracy
    # by having the model effectively ignore the 9 new features since they're
    # null → imputed 0 across every green_v1 row).
    _train_version = os.getenv('TRAIN_FEATURE_VERSION', FEATURE_SET_VERSION)
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
    """Return a closed-over loss function suitable for model.compile()."""
    huber = tf.keras.losses.Huber(delta=huber_delta)

    def joint_loss(y_true, y_pred):
        # Standard regression error (Huber on both heads, summed)
        reg_loss = huber(y_true, y_pred)

        # Inconsistency penalty: only fires when same-sign AND |6m| > k × |1y|
        p_6m = y_pred[:, 0]
        p_1y = y_pred[:, 1]
        abs_6m = tf.abs(p_6m)
        abs_1y = tf.abs(p_1y)
        same_sign = tf.cast(p_6m * p_1y > 0.0, tf.float32)
        overshoot = tf.nn.relu(abs_6m - ratio_threshold * abs_1y)
        # Soft penalty — quadratic in the overshoot magnitude
        consistency_loss = tf.reduce_mean(same_sign * tf.square(overshoot))

        # Opposite-sign penalty: zero when heads agree in direction, grows with
        # magnitude when they disagree — discourages the systemic 6m-down/1y-up bias.
        opposite_sign_penalty = tf.reduce_mean(tf.nn.relu(-p_6m * p_1y))

        return reg_loss + lambda_consistency * consistency_loss + lambda_opposite_sign * opposite_sign_penalty

    return joint_loss


def build_model(n_features, hidden, cap_6m, cap_1y, seed):
    """MLP with tanh × per-head cap on the output. Predictions are
    architecturally bounded to ±cap_6m on 126d and ±cap_1y on 252d, which
    prevents runaway outputs on unfamiliar feature combinations (the failure
    we saw in unbounded v2 on real fundamentals)."""
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
    """Fraction of predictions where same-signed AND |6m| > k × |1y|."""
    p6, p1 = pred[:, 0], pred[:, 1]
    same = np.sign(p6) == np.sign(p1)
    # Exclude zero-sign cases
    nonzero = (p6 != 0) & (p1 != 0)
    mask = same & nonzero
    if mask.sum() == 0:
        return 0.0, 0.0
    overshoot = np.abs(p6[mask]) - ratio_threshold * np.abs(p1[mask])
    trips = (overshoot > 0).sum()
    mean_overshoot = overshoot[overshoot > 0].mean() if trips > 0 else 0.0
    return trips / mask.sum(), float(mean_overshoot)


def opposite_sign_rate(pred, floor=0.05):
    """Fraction of material predictions where sign(6m) != sign(1y).

    'Material' means both abs(6m) > floor and abs(1y) > floor (in return units,
    so 0.05 = 5%). Mirrors the 5% threshold in the inference-time guardrail.
    Returns (rate, mean_magnitude) where mean_magnitude averages the two head
    magnitudes over the opposite-sign subset.
    """
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
    ap.add_argument('--huber-delta', type=float, default=0.5,
                    help="Huber loss delta for the standard regression term.")
    ap.add_argument('--lambda-consistency', type=float, default=1.0,
                    help="Weight on the 6m/1y inconsistency penalty term. 0 = no penalty.")
    ap.add_argument('--lambda-opposite-sign', type=float, default=1.0,
                    help="Weight on the opposite-sign penalty term. 0 = no penalty.")
    ap.add_argument('--ratio-threshold', type=float, default=1.5,
                    help="Penalty fires when same-signed AND |pred_6m| > ratio × |pred_1y|.")
    ap.add_argument('--cap-6m', type=float, default=0.7,
                    help="Output bound for 6m head via tanh × cap. 0.7 = ±70%%.")
    ap.add_argument('--cap-1y', type=float, default=1.0,
                    help="Output bound for 1y head via tanh × cap. 1.0 = ±100%%.")
    args = ap.parse_args()

    print(f"[{datetime.now().isoformat()}] Loading dataset...")
    conn = get_db(); df = load_dataset(conn); conn.close()
    n_total = len(df); n_tickers = df['ticker'].nunique()
    print(f"  rows: {n_total}  tickers: {n_tickers}  "
          f"date range: {df['snapshot_date'].min()} → {df['snapshot_date'].max()}")

    train_df, val_df = time_split(df, args.val_frac)
    print(f"  train: {len(train_df)}  val: {len(val_df)} "
          f"(cutoff: {val_df['snapshot_date'].min() if len(val_df) else 'n/a'})")

    X_train = train_df[CS_FEATURE_COLUMNS].values.astype(np.float32)
    X_val   = val_df[CS_FEATURE_COLUMNS].values.astype(np.float32)
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
    model = build_model(len(CS_FEATURE_COLUMNS), hidden, args.cap_6m, args.cap_1y, args.seed)
    loss_fn = make_joint_loss(args.lambda_consistency, args.huber_delta, args.ratio_threshold,
                              args.lambda_opposite_sign)
    model.compile(optimizer=Adam(learning_rate=1e-3), loss=loss_fn)

    es = EarlyStopping(monitor='val_loss', patience=15, restore_best_weights=True, verbose=0)
    print(f"\n[{datetime.now().isoformat()}] Training (epochs={args.epochs}, batch={args.batch_size})...")
    hist = model.fit(
        X_train_s, Y_train, validation_split=0.1,
        epochs=args.epochs, batch_size=args.batch_size,
        callbacks=[es], verbose=2,
    )
    print(f"  stopped at epoch {len(hist.history['loss'])}, "
          f"train={hist.history['loss'][-1]:.6f} val={hist.history['val_loss'][-1]:.6f}")

    # Val metrics on RAW targets (unclipped, as v1 does)
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

    # Per-ticker cv_mape on the 6m head — persisted onto the payload so the
    # inference path in predict_long_term.py can look up a real per-ticker
    # error instead of falling back to the vol proxy. Only include tickers
    # with ≥5 validation rows so single-shot outliers don't dominate.
    # Values are stored as percentage points (i.e. 0.35 = 35% MAPE) so the
    # inference path can slot them straight into confidence_score().
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

    # The headline metric for this experiment: inconsistency rate on val
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

    # Same metric on v1 for comparison if it's available
    v1_path = MODELS_DIR / 'long_term_cs_v1.pkl'
    if v1_path.exists():
        try:
            v1 = joblib.load(v1_path)
            v1_pred = v1['model'].predict(v1['scaler'].transform(X_val))
            v1_rate, v1_overshoot = consistency_rate(v1_pred, args.ratio_threshold)
            print(f"  [v1 baseline] inconsistency-rate: {100*v1_rate:.2f}%  "
                  f"mean overshoot: {v1_overshoot:.4f}")
            metrics['v1_baseline_inconsistency_rate'] = v1_rate
        except Exception as e:
            print(f"  [v1 baseline load failed: {e}]")

    # Opposite-sign baseline from current production model (loaded before we overwrite it)
    v2_prev_path = MODELS_DIR / 'long_term_cs_v2.pkl'
    if v2_prev_path.exists():
        try:
            v2_prev = joblib.load(v2_prev_path)
            v2_prev_pred = np.asarray(
                v2_prev['model'].predict(v2_prev['scaler'].transform(X_val))
            )
            v2_prev_opp, v2_prev_opp_mag = opposite_sign_rate(v2_prev_pred)
            print(f"  [v2_prev baseline] opposite-sign-rate: {100*v2_prev_opp:.2f}%  "
                  f"mean magnitude: {v2_prev_opp_mag:.4f}")
            metrics['v_prev_opposite_sign_rate'] = v2_prev_opp
            metrics['v_prev_mean_opposite_magnitude'] = v2_prev_opp_mag
        except Exception as e:
            print(f"  [v2_prev baseline load failed: {e}]")

    print(f"  pred range 6m: [{pred_val[:,0].min():+.3f}, {pred_val[:,0].max():+.3f}]")
    print(f"  pred range 1y: [{pred_val[:,1].min():+.3f}, {pred_val[:,1].max():+.3f}]")
    metrics['pred_range_6m'] = [float(pred_val[:,0].min()), float(pred_val[:,0].max())]
    metrics['pred_range_1y'] = [float(pred_val[:,1].min()), float(pred_val[:,1].max())]

    model.save(KERAS_PATH)
    payload = {
        'model': KerasModelWrapper(str(KERAS_PATH)),
        'scaler': scaler,
        'feature_columns': CS_FEATURE_COLUMNS,
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
        # Per-ticker cv_mape on the 6m head (percentage points). Consumed by
        # predict_long_term._predict_with_cs_model to replace the historical
        # 5% cv_mape heuristic with a real, per-ticker error measurement. When
        # a ticker isn't in this dict (new listing, not in training set, or
        # <5 val samples), the inference path falls through to the
        # backtest → vol-proxy → 5% cascade.
        'per_ticker_cv_mape':      per_ticker_cv_mape,
        'per_ticker_val_samples':  per_ticker_n,
    }
    joblib.dump(payload, WRAPPER_PATH)
    print(f"\n[saved] {KERAS_PATH}")
    print(f"[saved] {WRAPPER_PATH}")

    manifest = {
        'feature_columns': CS_FEATURE_COLUMNS,
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
