"""
predict_short_term.py — 1w / 1m horizon model.

Trains a 2-output MLP head on (p1d, p1w) using only the SHORT_TERM_FEATURES
mask (momentum / technical / microstructure). Post-processes:
  - 1w price = 50/50 blend of (MLP raw output, 1w trajectory anchor toward 3m)
    clamped to ±2× ATR(14) × √5.
  - 1m price = linear interpolation between predicted_price_1w and
    predicted_price_3m at t+21 trading days (matches the legacy trajectory
    builder's t+21 waypoint).

Long-term outputs (predicted_price_3m, confidence_score_3m) are explicit
function arguments — no hidden import path between horizon files.

Per-horizon optimizations vs the legacy monolithic 4-output MLP:
  - Feature mask: drops fundamentals + macro/commodity betas + WorldBank
    annual indicators that contribute little signal on 1w/1m timescales.
  - Hidden layers shrunk (96/48/24) since the mask is ~half the column
    count — same effective capacity-per-feature, faster training.

Cross-sectional pretrained path (Plan 4):
  Set ST_CS_MODEL_VERSION=v1 (or later) in .env.local to activate a
  pretrained snapshot model loaded from models/short_term_cs_v1.pkl.
  The per-ticker .fit() path is kept as a fallback and is always used when
  the env var is absent or the artifact is missing.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from sklearn.neural_network import MLPRegressor

from predict_core import (
    SEED, N_EPOCHS,
    SHORT_TERM_FEATURES, extend_with_regime_cols,
    make_horizon_sequences, slice_last_seq,
    ANALYST_BOOST_1W, ANALYST_BOOST_1M, MIN_ANALYSTS_FOR_BOOST_SHORT,
)


# Horizon constants — match the legacy predict() body so trajectory math
# stays equivalent.
T5  = 5    # 1 trading week
T21 = 21   # 1 trading month (approx)
T3M = 63   # 3 months (medium-term anchor for 1w/1m blending)


# ── Cross-sectional pretrained model loader (best-effort) ──────────────────
# Mirrors the pattern used in predict_long_term.py for the CS long-term model.
# Loaded once at module import; ST_CS_MODEL_VERSION='disabled' (default) skips
# loading so existing per-ticker behaviour is completely unchanged.
_ST_CS_MODEL: dict | None = None
_ST_CS_MODEL_VERSION = os.environ.get('ST_CS_MODEL_VERSION', 'disabled')

if _ST_CS_MODEL_VERSION != 'disabled':
    _st_cs_path = (
        Path(os.path.dirname(os.path.abspath(__file__))).parent
        / 'models'
        / f'short_term_cs_{_ST_CS_MODEL_VERSION}.pkl'
    )
    try:
        import joblib as _joblib
        if _st_cs_path.exists():
            _ST_CS_MODEL = _joblib.load(str(_st_cs_path))
            print(
                f'[short_term] loaded CS model v{_ST_CS_MODEL_VERSION}: '
                f'{len(_ST_CS_MODEL.get("feature_columns", []))} features, '
                f'trained_at {_ST_CS_MODEL.get("trained_at", "?")}',
                file=sys.stderr,
            )
        else:
            print(
                f'[short_term] CS model artifact not found at {_st_cs_path}; '
                'falling back to per-ticker training.',
                file=sys.stderr,
            )
    except Exception as _exc:
        print(
            f'[short_term] CS model load failed ({_exc}); '
            'falling back to per-ticker training.',
            file=sys.stderr,
        )
        _ST_CS_MODEL = None


def build_short_term_model(seed: int = SEED) -> MLPRegressor:
    """
    2-output MLP for [p1d, p1w]. Smaller than long-term: short-horizon
    features are a tighter set + we want faster retrain cadence.
    """
    return MLPRegressor(
        hidden_layer_sizes=(96, 48, 24),
        activation='relu',
        solver='adam',
        learning_rate_init=0.001,
        max_iter=N_EPOCHS,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=8,
        random_state=seed,
    )


def _predict_with_st_cs_model(
    *,
    feat_df,
    current_price: float,
    mult_1w: float,
    mult_1m: float,
    predicted_price_3m_base: float,
    confidence_score_3m: int,
    stock_metrics: dict,
) -> dict:
    """
    CS pretrained path: scale the current feature snapshot with the saved
    StandardScaler, predict [return_5d, return_21d], then apply the same
    post-processing (trajectory blend + ATR clamp + multipliers) as the
    per-ticker path.  No .fit() call occurs at inference time.
    """
    payload = _ST_CS_MODEL
    model_type = payload.get('model_type', 'mlp')
    scaler_cs = payload['scaler']
    cs_feature_cols = payload['feature_columns']

    # Build current feature vector from the last row of feat_df.
    # Columns absent from feat_df (schema drift or missing features) default to 0.
    last_row = feat_df.iloc[-1]
    x_current = np.array([
        float(last_row[col]) if col in feat_df.columns and not _isnan(last_row[col]) else 0.0
        for col in cs_feature_cols
    ], dtype=np.float32).reshape(1, -1)
    x_current = np.nan_to_num(x_current, nan=0.0, posinf=0.0, neginf=0.0)
    x_current_s = scaler_cs.transform(x_current)

    # Route inference by model type — lgbm and blend store separate 5d/21d
    # boosters under model_5d / model_21d rather than a single model key.
    if model_type == 'lgbm':
        ret_5d  = float(payload['model_5d'].predict(x_current_s)[0])
        ret_21d = float(payload['model_21d'].predict(x_current_s)[0])
    elif model_type == 'blend':
        lgbm_5d  = float(payload['model_5d'].predict(x_current_s)[0])
        lgbm_21d = float(payload['model_21d'].predict(x_current_s)[0])
        mlp_pred = payload['model'].predict(x_current_s)[0]
        ret_5d  = 0.5 * lgbm_5d  + 0.5 * float(mlp_pred[0])
        ret_21d = 0.5 * lgbm_21d + 0.5 * float(mlp_pred[1])
    else:  # mlp (default)
        mlp_pred = payload['model'].predict(x_current_s)[0]
        ret_5d, ret_21d = float(mlp_pred[0]), float(mlp_pred[1])

    _mlp_1w_base = current_price * (1.0 + ret_5d)
    _mlp_1m_base = current_price * (1.0 + ret_21d)

    # Raw MLP output before the trajectory anchor blend — surfaced for
    # instrumentation so Phase 2 can compare blended vs raw direction accuracy.
    predicted_price_1w_raw = float(np.clip(
        _mlp_1w_base * mult_1w,
        current_price * 0.5, current_price * 2.0,
    ))
    pct_1w_raw = round((predicted_price_1w_raw - current_price) / (current_price + 1e-9) * 100, 2)

    # 1w: 50/50 blend with trajectory anchor (same logic as per-ticker path).
    _traj_anchor_1w_base = current_price + (predicted_price_3m_base - current_price) * (T5 / T3M)
    _blended_1w_base = 0.50 * _mlp_1w_base + 0.50 * _traj_anchor_1w_base
    _blended_1w = _blended_1w_base * mult_1w

    _atr_1w = float(feat_df['ATR_14'].iloc[-1]) if 'ATR_14' in feat_df.columns else current_price * 0.02
    _max_move_1w = 2.0 * _atr_1w * np.sqrt(5)
    predicted_price_1w = float(np.clip(_blended_1w, current_price - _max_move_1w, current_price + _max_move_1w))
    pct_1w = round((predicted_price_1w - current_price) / (current_price + 1e-9) * 100, 2)

    # 1m: blend the CS 1m base with the 3m trajectory (mirrors per-ticker interpolation).
    t_norm = (T21 - T5) / (T3M - T5)
    _blended_1m_base = _blended_1w_base + (predicted_price_3m_base - _blended_1w_base) * t_norm
    _cs_1m_base = 0.50 * _mlp_1m_base + 0.50 * _blended_1m_base
    predicted_price_1m = _cs_1m_base * mult_1m
    pct_1m = round((predicted_price_1m - current_price) / (current_price + 1e-9) * 100, 2)

    # Confidence: same earnings-window logic as per-ticker path.
    days_to_earnings = 999
    next_earnings_str = stock_metrics.get('nextEarningsDate')
    if next_earnings_str:
        try:
            days_to_earnings = (
                datetime.fromisoformat(str(next_earnings_str)).date()
                - datetime.today().date()
            ).days
        except Exception:
            pass
    cs1m = max(0, confidence_score_3m - 10) if days_to_earnings <= 14 else min(100, confidence_score_3m + 10)
    cs1w = min(100, cs1m + 3)
    # signal_confidence resolved in outer predict_short_term after this returns.

    # Directional classifier — separate head trained to predict p(up) for 1w horizon.
    # Conviction gate: only surface directional signal when p_up is outside [0.4, 0.6].
    direction_confidence_1w = None
    direction_signal_1w = None
    clf_5d = payload.get('classifier_5d')
    if clf_5d is not None:
        try:
            direction_confidence_1w = round(float(clf_5d.predict_proba(x_current_s)[0, 1]), 4)
            if direction_confidence_1w > 0.55:
                direction_signal_1w = 'up'
            elif direction_confidence_1w < 0.45:
                direction_signal_1w = 'down'
            # else: low-conviction — leave as None
        except Exception:
            pass

    return {
        'predicted_price_1w':     predicted_price_1w,
        'predicted_price_1w_raw': predicted_price_1w_raw,
        'predicted_change_pct_1w':     pct_1w,
        'predicted_change_pct_1w_raw': pct_1w_raw,
        'confidence_score_1w': cs1w,
        'predicted_price_1m': predicted_price_1m,
        'predicted_change_pct_1m': pct_1m,
        'confidence_score_1m': cs1m,
        'direction_confidence_1w': direction_confidence_1w,
        'direction_signal_1w':     direction_signal_1w,
    }


def _isnan(v) -> bool:
    try:
        return v != v  # NaN check without importing math
    except Exception:
        return False


def predict_short_term(
    *,
    scaled,
    feature_columns,
    targets_1d,
    targets_1w,
    feat_df,
    current_price: float,
    non_analyst_impact: float,
    analyst_impact: float,
    analyst_count: int,
    consumer_multiplier: float,
    scaler,
    close_col_idx: int,
    n_features: int,
    predicted_price_3m_base: float,
    confidence_score_3m: int,
    stock_metrics: dict,
    seed: int = SEED,
    signal_confidence_3m: int = 65,
) -> dict:
    """
    Train + predict the 1w / 1m horizon using SHORT_TERM_FEATURES.

    Composes its own per-horizon multipliers from non_analyst_impact +
    analyst_impact × per-horizon boost. The analyst contribution is gated by
    MIN_ANALYSTS_FOR_BOOST_SHORT — below that, short-term predictions get no
    analyst lift (avoids noisy single-firm coverage on small caps moving
    near-term prices).

    The 1w trajectory anchor uses `predicted_price_3m_base` — the long-term
    model's pre-multiplier 3m output — so analyst weighting doesn't leak
    from the LT boost (1.67×) into the 1w prediction via the anchor.

    Returns the 6 short-horizon output fields:
      predicted_price_1w / change_pct_1w / confidence_score_1w
      predicted_price_1m / change_pct_1m / confidence_score_1m
    """
    # ── Per-horizon multipliers ─────────────────────────────────────────────
    # Floor on short-term: low-coverage stocks ignore the analyst boost
    # entirely. Long-term doesn't have this floor (handled in predict_core's
    # reliability ramp inside metric_analysis()).
    applied_analyst = analyst_impact if analyst_count >= MIN_ANALYSTS_FOR_BOOST_SHORT else 0.0
    mult_1w = (1.0 + non_analyst_impact + applied_analyst * ANALYST_BOOST_1W) * consumer_multiplier
    mult_1m = (1.0 + non_analyst_impact + applied_analyst * ANALYST_BOOST_1M) * consumer_multiplier

    # ── CS pretrained path (ST_CS_MODEL_VERSION != 'disabled') ───────────────
    # Short-circuits before the per-ticker .fit() call if the pretrained
    # artifact was successfully loaded at module import.
    if _ST_CS_MODEL is not None:
        cs_result = _predict_with_st_cs_model(
            feat_df=feat_df,
            current_price=current_price,
            mult_1w=mult_1w,
            mult_1m=mult_1m,
            predicted_price_3m_base=predicted_price_3m_base,
            confidence_score_3m=confidence_score_3m,
            stock_metrics=stock_metrics,
        )
        # signal_confidence was intentionally deferred to here (see comment in
        # _predict_with_st_cs_model) — apply the same earnings-window logic.
        _days_to_earn = 999
        _next_earn_str = stock_metrics.get('nextEarningsDate')
        if _next_earn_str:
            try:
                _days_to_earn = (
                    datetime.fromisoformat(str(_next_earn_str)).date()
                    - datetime.today().date()
                ).days
            except Exception:
                pass
        _sig_1m = max(0, signal_confidence_3m - 10) if _days_to_earn <= 14 else min(100, signal_confidence_3m + 10)
        cs_result['signal_confidence_1m'] = _sig_1m
        cs_result['signal_confidence_1w'] = min(100, _sig_1m + 3)
        return cs_result

    # ── Per-ticker training path (default) ───────────────────────────────────
    short_features = extend_with_regime_cols(SHORT_TERM_FEATURES)
    mask_indices = [feature_columns.index(f) for f in short_features if f in feature_columns]

    targets_stacked = np.column_stack([targets_1d, targets_1w])
    X, Y = make_horizon_sequences(scaled, targets_stacked, mask_indices)
    if len(X) < 50:
        raise ValueError("Not enough sequences for short-term training.")

    last_seq = slice_last_seq(scaled, mask_indices)

    # ── Train ────────────────────────────────────────────────────────────────
    model = build_short_term_model(seed=seed)
    model.fit(X, Y)

    pred_scaled = model.predict(last_seq)[0]  # [p1d, p1w]

    def inverse_close(scaled_val):
        dummy = np.zeros((1, n_features), dtype=np.float32)
        dummy[0, close_col_idx] = float(scaled_val)
        return float(scaler.inverse_transform(dummy)[0, close_col_idx])

    # ── 1-week blend (MLP head + trajectory anchor) ──────────────────────────
    # 50/50 blend of model output and a trajectory anchor toward the 3m
    # PRE-MULTIPLIER price. Using the pre-multiplier base prevents the LT
    # analyst boost (1.67×) from leaking into 1w via the anchor — 1w gets its
    # own 0.25× boost via mult_1w applied at the end.
    _mlp_1w_base = inverse_close(pred_scaled[1])

    # Raw MLP output before the trajectory anchor blend — surfaced for
    # instrumentation so Phase 2 can compare blended vs raw direction accuracy.
    predicted_price_1w_raw = float(np.clip(
        _mlp_1w_base * mult_1w,
        current_price * 0.5, current_price * 2.0,
    ))
    pct_1w_raw = round((predicted_price_1w_raw - current_price) / (current_price + 1e-9) * 100, 2)

    _traj_anchor_1w_base = current_price + (predicted_price_3m_base - current_price) * (T5 / T3M)
    _blended_1w_base = 0.50 * _mlp_1w_base + 0.50 * _traj_anchor_1w_base
    _blended_1w = _blended_1w_base * mult_1w

    _atr_1w = float(feat_df['ATR_14'].iloc[-1]) if 'ATR_14' in feat_df.columns else current_price * 0.02
    _max_move_1w = 2.0 * _atr_1w * np.sqrt(5)
    predicted_price_1w = float(np.clip(
        _blended_1w,
        current_price - _max_move_1w,
        current_price + _max_move_1w,
    ))

    pct_1w = round((predicted_price_1w - current_price) / (current_price + 1e-9) * 100, 2)

    # ── 1-month interpolation (matches legacy trajectory[1] at t+21) ─────────
    # Interpolate on pre-multiplier bases, then apply mult_1m (which has the
    # 0.83× analyst boost) at the end. Keeps each horizon's analyst weight
    # independent.
    t_norm = (T21 - T5) / (T3M - T5)
    predicted_price_1m_base = _blended_1w_base + (predicted_price_3m_base - _blended_1w_base) * t_norm
    predicted_price_1m = predicted_price_1m_base * mult_1m
    pct_1m = round((predicted_price_1m - current_price) / (current_price + 1e-9) * 100, 2)

    # ── 1m confidence: earnings-window aware ─────────────────────────────────
    days_to_earnings = 999
    next_earnings_str = stock_metrics.get('nextEarningsDate')
    if next_earnings_str:
        try:
            days_to_earnings = (datetime.fromisoformat(str(next_earnings_str)).date()
                                 - datetime.today().date()).days
        except Exception:
            pass
    if days_to_earnings <= 14:
        cs1m = max(0, confidence_score_3m - 10)
    else:
        cs1m = min(100, confidence_score_3m + 10)

    cs1w = min(100, cs1m + 3)

    # Signal confidence mirrors the same earnings-window logic as blended confidence.
    sig_1m = max(0, signal_confidence_3m - 10) if days_to_earnings <= 14 else min(100, signal_confidence_3m + 10)
    sig_1w = min(100, sig_1m + 3)

    return {
        'predicted_price_1w':          predicted_price_1w,
        'predicted_price_1w_raw':      predicted_price_1w_raw,
        'predicted_change_pct_1w':     pct_1w,
        'predicted_change_pct_1w_raw': pct_1w_raw,
        'confidence_score_1w': cs1w,
        'predicted_price_1m': predicted_price_1m,
        'predicted_change_pct_1m': pct_1m,
        'confidence_score_1m': cs1m,
        'signal_confidence_1w': sig_1w,
        'signal_confidence_1m': sig_1m,
    }
