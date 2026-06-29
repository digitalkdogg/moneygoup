"""
predict_short_term.py — 1w / 1m horizon model.

Trains a 2-output MLP head on (p1d, p1w) using only the SHORT_TERM_FEATURES
mask (momentum / technical / microstructure). Post-processes:
  - 1w price = 30/70 blend of (MLP raw output, 1w trajectory anchor toward 6m)
    clamped to ±2× ATR(14) × √5.
  - 1m price = linear interpolation between predicted_price_1w and
    predicted_price_6m at t+21 trading days (matches the legacy trajectory
    builder's t+21 waypoint).

Long-term outputs (predicted_price_6m, confidence_score_6m) are explicit
function arguments — no hidden import path between horizon files.

Per-horizon optimizations vs the legacy monolithic 4-output MLP:
  - Feature mask: drops fundamentals + macro/commodity betas + WorldBank
    annual indicators that contribute little signal on 1w/1m timescales.
  - Hidden layers shrunk (96/48/24) since the mask is ~half the column
    count — same effective capacity-per-feature, faster training.
"""

from datetime import datetime

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
T5 = 5      # 1 trading week
T21 = 21    # 1 trading month (approx)
T6 = 126    # 6 months


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
    predicted_price_6m_base: float,
    confidence_score_6m: int,
    stock_metrics: dict,
    seed: int = SEED,
) -> dict:
    """
    Train + predict the 1w / 1m horizon using SHORT_TERM_FEATURES.

    Composes its own per-horizon multipliers from non_analyst_impact +
    analyst_impact × per-horizon boost. The analyst contribution is gated by
    MIN_ANALYSTS_FOR_BOOST_SHORT — below that, short-term predictions get no
    analyst lift (avoids noisy single-firm coverage on small caps moving
    near-term prices).

    The 1w trajectory anchor uses `predicted_price_6m_base` — the long-term
    model's pre-multiplier 6m output — so analyst weighting doesn't leak
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

    # ── Feature mask + sequence build ────────────────────────────────────────
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
    # 50/50 blend of model output and a trajectory anchor toward the 6m
    # PRE-MULTIPLIER price. Using the pre-multiplier base prevents the LT
    # analyst boost (1.67×) from leaking into 1w via the anchor — 1w gets its
    # own 0.25× boost via mult_1w applied at the end.
    _mlp_1w_base = inverse_close(pred_scaled[1])
    _traj_anchor_1w_base = current_price + (predicted_price_6m_base - current_price) * (T5 / T6)
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
    t_norm = (T21 - T5) / (T6 - T5)
    predicted_price_1m_base = _blended_1w_base + (predicted_price_6m_base - _blended_1w_base) * t_norm
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
        cs1m = max(0, confidence_score_6m - 10)
    else:
        cs1m = min(100, confidence_score_6m + 10)

    cs1w = min(100, cs1m + 3)

    return {
        'predicted_price_1w': predicted_price_1w,
        'predicted_change_pct_1w': pct_1w,
        'confidence_score_1w': cs1w,
        'predicted_price_1m': predicted_price_1m,
        'predicted_change_pct_1m': pct_1m,
        'confidence_score_1m': cs1m,
    }
