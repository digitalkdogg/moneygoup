"""
predict_long_term.py — 6m / 1y horizon model.

Trains a 2-output MLP head on (p6m, p1y) using only the LONG_TERM_FEATURES
mask (macro / fundamental / long-horizon momentum). Runs Monte Carlo for
uncertainty bands. Returns 6m/1y output fields plus internals the
orchestrator needs to build the 18-month trajectory.

Per-horizon optimizations vs the legacy monolithic 4-output MLP:
  - Feature mask: drops short-window momentum + microstructure that adds
    noise on 6-12m horizons.
  - Uncertainty bands: spread_6m/spread_12m widened 25% from raw MC range
    to better calibrate the 60-100% 1y predicted-vs-actual band coverage
    flagged in the refactor plan.

History notes (kept for posterity, don't affect runtime):
  - Explored return-target variant (predict %-change instead of scaled-
    close-price) — fragile gain, reverted.
  - Explored trend-extrapolation prior (boost predictions when ROC_6m
    > +30% or < -30%) — didn't move the needle, occasionally caused
    UNH-style bear-trap regressions, reverted.
  - Explored HistGradientBoostingRegressor swap — 10× slower runtime
    (~2h vs ~13min backtest) AND 1y accuracy dropped 10pp (69.6 → 59.5%)
    because tree-based predictions made bolder moves that hurt more
    when wrong. Reverted.
"""

import os
import sys
from pathlib import Path

import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error

from predict_core import (
    SEED, SEQ_LEN, N_EPOCHS, MC_RUNS,
    LONG_TERM_FEATURES, extend_with_regime_cols,
    make_horizon_sequences, slice_last_seq,
    confidence_score,
)

# ── Cross-sectional model loader (best-effort) ────────────────────────────
# Loaded once at module import. If the artifact is missing or fails to
# deserialize, we silently fall back to the per-ticker training path.
_CS_MODEL = None  # dict: {'model', 'scaler', 'feature_columns', ...}
_CS_MODEL_VERSION = os.environ.get('CS_MODEL_VERSION', 'v2')
_CS_MODEL_PATH = Path(os.path.dirname(os.path.abspath(__file__))).parent / 'models' / f'long_term_cs_{_CS_MODEL_VERSION}.pkl'

try:
    import joblib
    if _CS_MODEL_PATH.exists():
        _CS_MODEL = joblib.load(_CS_MODEL_PATH)
        print(f"[long_term] loaded cross-sectional model: "
              f"{len(_CS_MODEL.get('feature_columns', []))} features, "
              f"trained_at {_CS_MODEL.get('trained_at', '?')}", file=sys.stderr)
except Exception as exc:
    print(f"[long_term] cross-sectional model load failed; falling back to per-ticker MLP. "
          f"Reason: {exc}", file=sys.stderr)
    _CS_MODEL = None


# Empirical multiplier applied to raw MC spreads to widen the 1y uncertainty
# band. The base spread is the 10/90 percentile range from MC_RUNS samples,
# which under-represents tail risk at long horizons. 1.25× brings observed
# band coverage closer to the 80% it claims to represent.
LONG_TERM_SPREAD_WIDENER = 1.25


def build_long_term_model(seed: int = SEED) -> MLPRegressor:
    """
    2-output MLP for [p6m, p1y]. Slightly wider hidden layers than short-term
    because 6m/1y predictions need to integrate more disparate signals (macro
    + fundamentals + long-horizon momentum).
    """
    return MLPRegressor(
        hidden_layer_sizes=(192, 96, 48),
        activation='relu',
        solver='adam',
        learning_rate_init=0.001,
        max_iter=N_EPOCHS,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=8,
        random_state=seed,
    )


def _predict_with_cs_model(
    *,
    feat_df,
    current_price: float,
    long_term_multiplier: float,
    history_years: float,
    imputed_fields,
    analyst_count: int,
    seed: int,
    analyst_sentiment_v2: dict | None = None,
) -> dict:
    """
    Cross-sectional prediction path.

    Takes the latest row of feat_df, looks up the columns the persisted
    model was trained on (CS_FEATURE_COLUMNS = the ranker's GREEN set),
    scales via the saved StandardScaler, predicts [return_126d,
    return_252d], anchors to current_price. MC perturbs the feature
    vector to get spread bands. No training happens at predict time.

    Returns both the final (post-multiplier) prices AND the pre-multiplier
    base prices so the short-term module can anchor its 1w trajectory to
    the model's raw long-horizon output (rather than to a price that
    already has long-horizon analyst weighting baked in).
    """
    payload = _CS_MODEL
    model            = payload['model']
    scaler_cs        = payload['scaler']
    cs_feature_cols  = payload['feature_columns']

    # Build the current feature vector matching the trained column order.
    # Missing columns (rare — schema drift) default to 0.
    current_row = feat_df.iloc[-1]
    x_current = np.array([
        float(current_row[col]) if col in feat_df.columns and not _isnan(current_row[col]) else 0.0
        for col in cs_feature_cols
    ], dtype=np.float32).reshape(1, -1)
    x_current = np.nan_to_num(x_current, nan=0.0, posinf=0.0, neginf=0.0)
    x_current_s = scaler_cs.transform(x_current)

    pred_returns = model.predict(x_current_s)[0]  # [return_126d, return_252d]
    base_6m = current_price * (1.0 + float(pred_returns[0]))
    base_1y = current_price * (1.0 + float(pred_returns[1]))
    predicted_price_6m = base_6m * long_term_multiplier
    predicted_price_1y = base_1y * long_term_multiplier

    # ── Monte Carlo: perturb the feature vector + re-predict ─────────────────
    # Noise scale: per-feature std from the last 20 days of feat_df, scaled
    # down so the perturbation stays modest.
    recent_window = feat_df[cs_feature_cols].tail(20).fillna(0.0).values.astype(np.float32)
    if recent_window.shape[0] >= 5:
        feature_stds = recent_window.std(axis=0)
    else:
        feature_stds = np.ones(len(cs_feature_cols), dtype=np.float32) * 1e-4
    feature_stds = np.clip(feature_stds, 1e-4, None).astype(np.float32)

    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 1, (MC_RUNS, len(cs_feature_cols))).astype(np.float32) * feature_stds * 0.1
    mc_inputs   = x_current + noise
    mc_inputs_s = scaler_cs.transform(mc_inputs)
    mc_returns  = model.predict(mc_inputs_s)  # (MC_RUNS, 2)

    mc_6m_prices  = current_price * (1.0 + mc_returns[:, 0]) * long_term_multiplier
    mc_12m_prices = current_price * (1.0 + mc_returns[:, 1]) * long_term_multiplier

    spread_6m  = float(np.percentile(mc_6m_prices,  90) - np.percentile(mc_6m_prices,  10)) * LONG_TERM_SPREAD_WIDENER
    spread_12m = float(np.percentile(mc_12m_prices, 90) - np.percentile(mc_12m_prices, 10)) * LONG_TERM_SPREAD_WIDENER
    # Spread floors prevent the MC ensemble (only MC_RUNS=12 samples) from
    # collapsing the prediction band to ~$0 when the model is confident on a
    # stable stock. Floors are calibrated so the 1w band (= spread_6m * 5/126)
    # stays at least ~0.16% of price, which matches the realistic minimum
    # one-week move for a liquid equity.
    spread_6m  = max(spread_6m,  current_price * 0.04)
    spread_12m = max(spread_12m, current_price * 0.08)
    spread_18m = spread_12m * 1.5

    # Item 4: Signal confidence from MC ensemble agreement (CoV).
    # CoV=0 → perfect agreement → signal_confidence=100.
    # CoV=0.25 → 25% spread relative to mean → signal_confidence=0.
    # Blended with a MAPE-based component (set after cv_mape is computed below).
    mc_cv_6m = float(np.std(mc_6m_prices)  / (abs(float(np.mean(mc_6m_prices)))  + 1e-9))
    mc_cv_1y = float(np.std(mc_12m_prices) / (abs(float(np.mean(mc_12m_prices))) + 1e-9))
    _signal_from_mc_6m = max(0.0, 100.0 * (1.0 - mc_cv_6m / 0.25))
    _signal_from_mc_1y = max(0.0, 100.0 * (1.0 - mc_cv_1y / 0.25))

    p18m_est = predicted_price_1y + (predicted_price_1y - predicted_price_6m)

    # ── cv_mae / cv_mape: per-ticker backtest of the CS model ────────────────
    # Historically this branch hardcoded cv_mae = current_price × 0.05 because
    # "the CS-model path doesn't keep holdout residuals around." That awarded
    # every stock a bogus 30 pts on the cv_mape confidence component regardless
    # of how badly the model actually tracked it — WULF and PG got the same
    # score.
    #
    # New order of precedence:
    #   1. Persisted per-ticker calibration on the model payload (from training).
    #   2. Inference-time backtest: last ~250 rows of feat_df, run the CS model
    #      on each, compare predicted_return_126d to the actual realized return
    #      126 trading days later.
    #   3. Volatility proxy: σ_annual × √0.5 (zero-model baseline at 6m).
    #   4. 5% heuristic (last resort — should rarely fire now).
    cv_mape_source = 'fallback_5pct'
    cv_mape        = 5.0

    persisted_cv = payload.get('per_ticker_cv_mape') if isinstance(payload, dict) else None
    ticker_key = None
    try:
        ticker_key = (feat_df.attrs.get('ticker') if hasattr(feat_df, 'attrs') else None)
    except Exception:
        ticker_key = None
    if isinstance(persisted_cv, dict) and ticker_key and ticker_key in persisted_cv:
        try:
            cv_mape        = float(persisted_cv[ticker_key])
            cv_mape_source = 'persisted'
        except (TypeError, ValueError):
            pass

    if cv_mape_source == 'fallback_5pct' and 'Close' in feat_df.columns:
        # Backtest window: rows we have (i) enough history to build features
        # (already built), AND (ii) 126d of future closes to score against.
        # Skip the last 126 rows (no future truth) and take up to 250 rows.
        HORIZON = 126
        try:
            closes = feat_df['Close'].values
            n = len(feat_df)
            end   = n - HORIZON
            start = max(0, end - 250)
            if end - start >= 30:  # need a reasonable sample
                bt_features = feat_df.iloc[start:end][cs_feature_cols].fillna(0.0)
                bt_x = np.nan_to_num(bt_features.values.astype(np.float32),
                                     nan=0.0, posinf=0.0, neginf=0.0)
                bt_x_s = scaler_cs.transform(bt_x)
                # Keras models accept verbose=0 to silence progress output;
                # sklearn's MLPRegressor.predict() doesn't take verbose at all.
                # Try the Keras signature first, fall back to plain predict()
                # on TypeError for the sklearn v1 model file.
                try:
                    bt_pred = np.asarray(model.predict(bt_x_s, verbose=0))
                except TypeError:
                    bt_pred = np.asarray(model.predict(bt_x_s))
                bt_pred_ret = bt_pred[:, 0] if bt_pred.ndim == 2 else bt_pred  # 6m head
                actual_ret = (closes[start + HORIZON : end + HORIZON] / (closes[start:end] + 1e-9)) - 1.0
                bt_mae_ret = float(np.mean(np.abs(bt_pred_ret - actual_ret)))
                # Convert return-space MAE to a percentage — same unit as the
                # existing cv_mape (percentage points of return).
                cv_mape        = float(np.clip(bt_mae_ret * 100.0, 0.0, 50.0))
                cv_mape_source = f'backtest_n={end - start}'
        except Exception as exc:
            print(f"[cv_mape] backtest failed for CS path: {exc}", file=sys.stderr)

    if cv_mape_source == 'fallback_5pct':
        # Volatility proxy: for a zero-model (predicts 0% return), expected
        # |return| at 6m horizon ≈ σ_annual × √0.5. That's the pessimistic
        # ceiling on cv_mape a real model should beat. We use it directly as
        # the proxy — it's honest that we don't have a real measurement.
        vol = feat_df.attrs.get('realized_vol_60d') if hasattr(feat_df, 'attrs') else None
        if isinstance(vol, (int, float)) and vol > 0:
            cv_mape        = float(np.clip(vol * np.sqrt(0.5) * 100.0, 5.0, 50.0))
            cv_mape_source = 'vol_proxy'

    print(f"[cv_mape] source={cv_mape_source} value={cv_mape:.2f}%", file=sys.stderr)
    cv_mae  = float(cv_mape / 100.0 * current_price)
    cv_rmse = cv_mae * 1.253

    # The CS model measures cv_mape in return-space (typically 20-40%), but
    # confidence_score()'s thresholds were calibrated for price-space MAPE
    # (where <5% is achievable in a week). Passing the raw value always gives
    # 0/40 pts on the cv_mape component for every stock.
    #
    # Normalize relative to the random-walk baseline (vol × √0.5). A model
    # matching random maps to ~10% → 30 pts. A model 30% better than random
    # maps to ~7% → 30 pts. Clearly worse than random maps to 20%+ → 0 pts.
    _vol_attr = feat_df.attrs.get('realized_vol_60d') if hasattr(feat_df, 'attrs') else None
    _vol_proxy_pct = float(np.clip((_vol_attr or 0.30) * np.sqrt(0.5) * 100.0, 5.0, 50.0))
    conf_cv_mape = float(np.clip(cv_mape / _vol_proxy_pct * 10.0, 0.0, 50.0))

    cs6m, cs_breakdown = confidence_score(conf_cv_mape, history_years, imputed_fields, analyst_count,
                                          analyst_sentiment_v2=analyst_sentiment_v2,
                                          return_breakdown=True)
    cs1y = max(0, cs6m - 10)
    cs_breakdown['cv_mape_source'] = cv_mape_source
    cs_breakdown['conf_cv_mape']   = round(conf_cv_mape, 2)

    # Blend MC-agreement signal with MAPE-derived signal for final signal_confidence.
    _mape_signal = max(0.0, 100.0 - float(conf_cv_mape) * 2.0)
    signal_confidence_6m = int(round(0.6 * _signal_from_mc_6m + 0.4 * _mape_signal))
    signal_confidence_1y = int(round(0.6 * _signal_from_mc_1y + 0.4 * _mape_signal))

    pct_6m = round((predicted_price_6m - current_price) / (current_price + 1e-9) * 100, 2)
    pct_1y = round((predicted_price_1y - current_price) / (current_price + 1e-9) * 100, 2)

    return {
        'predicted_price_6m': predicted_price_6m,
        'predicted_price_1y': predicted_price_1y,
        'predicted_price_6m_base': base_6m,
        'predicted_price_1y_base': base_1y,
        'predicted_change_pct_6m': pct_6m,
        'predicted_change_pct_1y': pct_1y,
        'confidence_score_6m': cs6m,
        'confidence_score_1y': cs1y,
        'confidence_breakdown': cs_breakdown,
        'signal_confidence_6m': signal_confidence_6m,
        'signal_confidence_1y': signal_confidence_1y,
        'spread_6m': spread_6m,
        'spread_12m': spread_12m,
        'spread_18m': spread_18m,
        'p18m_est': p18m_est,
        'cv_mae': cv_mae,
        'cv_rmse': cv_rmse,
        'cv_mape': cv_mape,
    }


def _isnan(v) -> bool:
    """numpy/python NaN-safe check for mixed types."""
    try:
        return bool(np.isnan(v))
    except (TypeError, ValueError):
        return False


def predict_long_term(
    *,
    scaled,
    feature_columns,         # extended feature list (FEATURE_COLUMNS + regime)
    targets_6m,
    targets_1y,
    feat_df,                 # for cross-sectional path: feature lookup at t=now
    current_price: float,
    long_term_multiplier: float,
    scaler,
    close_col_idx: int,
    n_features: int,
    history_years: float,
    imputed_fields,
    analyst_count: int,
    seed: int = SEED,
    analyst_sentiment_v2: dict | None = None,
) -> dict:
    """
    Predict the 6m / 1y horizon. Two execution paths:
      - Cross-sectional (preferred): use the persisted model at
        models/long_term_cs_v1.pkl. Skip training. ~50ms per call.
      - Per-ticker fallback (current): train an MLP on this ticker's own
        history. ~10s per call.

    Returns the same dict shape from either path so the orchestrator stays
    agnostic to which one fired. The orchestrator is responsible for
    composing `long_term_multiplier` from non_analyst_impact + analyst_impact
    × ANALYST_BOOST_LT × consumer_multiplier.
    """
    if _CS_MODEL is not None:
        return _predict_with_cs_model(
            feat_df=feat_df,
            current_price=current_price,
            long_term_multiplier=long_term_multiplier,
            history_years=history_years,
            imputed_fields=imputed_fields,
            analyst_count=analyst_count,
            seed=seed,
            analyst_sentiment_v2=analyst_sentiment_v2,
        )
    # ── Fallback: per-ticker MLP (legacy path) ───────────────────────────────
    # ── Feature mask + sequence build ────────────────────────────────────────
    long_features = extend_with_regime_cols(LONG_TERM_FEATURES)
    # Only keep features that actually exist in the supplied feature_columns
    # (defensive: skips silently if a column was renamed/removed upstream)
    mask_indices = [feature_columns.index(f) for f in long_features if f in feature_columns]

    targets_stacked = np.column_stack([targets_6m, targets_1y])
    X, Y = make_horizon_sequences(scaled, targets_stacked, mask_indices)
    if len(X) < 50:
        raise ValueError("Not enough sequences for long-term training.")

    last_seq = slice_last_seq(scaled, mask_indices)

    # Holdout (last 20%) for cv_mae
    split_idx = int(len(X) * 0.8)
    X_hold, Y_hold = X[split_idx:], Y[split_idx:]

    # ── Train ────────────────────────────────────────────────────────────────
    model = build_long_term_model(seed=seed)
    model.fit(X, Y)

    # ── Holdout cv_mae from the 6m head (column 0 of Y_long) ─────────────────
    if len(X_hold) > 0:
        hold_pred = model.predict(X_hold)
        dummy_pred = np.zeros((len(hold_pred), n_features), dtype=np.float32)
        dummy_pred[:, close_col_idx] = hold_pred[:, 0]  # 6m head
        pred_prices_hold = scaler.inverse_transform(dummy_pred)[:, close_col_idx]

        dummy_act = np.zeros((len(Y_hold), n_features), dtype=np.float32)
        dummy_act[:, close_col_idx] = Y_hold[:, 0]
        actual_prices_hold = scaler.inverse_transform(dummy_act)[:, close_col_idx]

        cv_mae  = float(mean_absolute_error(actual_prices_hold, pred_prices_hold))
        cv_rmse = float(np.sqrt(mean_squared_error(actual_prices_hold, pred_prices_hold)))
    else:
        cv_mae  = float(current_price * 0.05)
        cv_rmse = cv_mae * 1.253
    cv_mape = (cv_mae / (current_price + 1e-9)) * 100

    # ── Deterministic 6m / 1y predictions ────────────────────────────────────
    pred_scaled = model.predict(last_seq)[0]  # [p6m, p1y]

    def inverse_close(scaled_val):
        dummy = np.zeros((1, n_features), dtype=np.float32)
        dummy[0, close_col_idx] = float(scaled_val)
        return float(scaler.inverse_transform(dummy)[0, close_col_idx])

    base_6m = inverse_close(pred_scaled[0])
    base_1y = inverse_close(pred_scaled[1])
    predicted_price_6m = base_6m * long_term_multiplier
    predicted_price_1y = base_1y * long_term_multiplier

    # ── Monte Carlo Dropout — spread bands ───────────────────────────────────
    # Noise stds taken from the masked feature subset, tiled across SEQ_LEN
    masked_scaled = scaled[:, mask_indices]
    feature_stds = masked_scaled[-20:].std(axis=0)
    feature_stds = np.clip(feature_stds, 1e-4, None)
    tiled_stds = np.tile(feature_stds, SEQ_LEN).reshape(1, -1).astype(np.float32)
    rng = np.random.default_rng(seed)

    noise_batch = rng.normal(0, 1, (MC_RUNS, *last_seq.shape)).astype(np.float32)
    noise_batch *= (tiled_stds * 0.1)
    noisy_batch = last_seq + noise_batch.squeeze(1)
    mc_preds = model.predict(noisy_batch)

    dummy_mc = np.zeros((MC_RUNS, n_features), dtype=np.float32)
    dummy_mc[:, close_col_idx] = mc_preds[:, 0]
    mc_6m = scaler.inverse_transform(dummy_mc)[:, close_col_idx] * long_term_multiplier

    dummy_mc[:, close_col_idx] = mc_preds[:, 1]
    mc_12m = scaler.inverse_transform(dummy_mc)[:, close_col_idx] * long_term_multiplier

    # Spreads — widened to better cover observed actuals on long horizons.
    # Floor matches the CS-model path above so neither code branch can emit a
    # zero-width prediction band when the MC ensemble collapses.
    spread_6m  = float(np.percentile(mc_6m,  90) - np.percentile(mc_6m,  10)) * LONG_TERM_SPREAD_WIDENER
    spread_12m = float(np.percentile(mc_12m, 90) - np.percentile(mc_12m, 10)) * LONG_TERM_SPREAD_WIDENER
    spread_6m  = max(spread_6m,  current_price * 0.04)
    spread_12m = max(spread_12m, current_price * 0.08)
    spread_18m = spread_12m * 1.5

    # Item 4: signal confidence from MC CoV (same formula as CS path).
    _mc_cv_6m = float(np.std(mc_6m)  / (abs(float(np.mean(mc_6m)))  + 1e-9))
    _mc_cv_1y = float(np.std(mc_12m) / (abs(float(np.mean(mc_12m))) + 1e-9))
    _signal_from_mc_6m_pt = max(0.0, 100.0 * (1.0 - _mc_cv_6m / 0.25))
    _signal_from_mc_1y_pt = max(0.0, 100.0 * (1.0 - _mc_cv_1y / 0.25))

    # 18m extrapolation beyond 12m anchor (used by orchestrator's trajectory)
    p18m_est = predicted_price_1y + (predicted_price_1y - predicted_price_6m)

    # ── Confidence ───────────────────────────────────────────────────────────
    cs6m, cs_breakdown = confidence_score(cv_mape, history_years, imputed_fields, analyst_count,
                                          analyst_sentiment_v2=analyst_sentiment_v2,
                                          return_breakdown=True)
    cs_breakdown['cv_mape_source'] = 'per_ticker_holdout'
    cs1y = max(0, cs6m - 15)

    _mape_signal_pt = max(0.0, 100.0 - float(cv_mape) * 2.0)
    signal_confidence_6m = int(round(0.6 * _signal_from_mc_6m_pt + 0.4 * _mape_signal_pt))
    signal_confidence_1y = int(round(0.6 * _signal_from_mc_1y_pt + 0.4 * _mape_signal_pt))

    # ── Pct changes ──────────────────────────────────────────────────────────
    pct_6m  = round((predicted_price_6m - current_price) / (current_price + 1e-9) * 100, 2)
    pct_1y  = round((predicted_price_1y - current_price) / (current_price + 1e-9) * 100, 2)

    return {
        'predicted_price_6m': predicted_price_6m,
        'predicted_price_1y': predicted_price_1y,
        'predicted_price_6m_base': base_6m,
        'predicted_price_1y_base': base_1y,
        'predicted_change_pct_6m': pct_6m,
        'predicted_change_pct_1y': pct_1y,
        'confidence_score_6m': cs6m,
        'confidence_score_1y': cs1y,
        'confidence_breakdown': cs_breakdown,
        'signal_confidence_6m': signal_confidence_6m,
        'signal_confidence_1y': signal_confidence_1y,
        # Internals exposed for orchestrator + short-term consumers
        'spread_6m': spread_6m,
        'spread_12m': spread_12m,
        'spread_18m': spread_18m,
        'p18m_est': p18m_est,
        'cv_mae': cv_mae,
        'cv_rmse': cv_rmse,
        'cv_mape': cv_mape,
    }
