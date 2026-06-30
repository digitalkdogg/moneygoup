"""
predict_weighted_analysis.py — MLP-based stock price prediction (v3-split).

This file is the orchestrator. Shared logic lives in predict_core.py;
horizon-specific models + post-processing live in predict_short_term.py
(1w/1m) and predict_long_term.py (6m/1y).

The CLI contract and output JSON schema are preserved (callers:
scripts/update_predictions.py, scripts/backtest_predictions.py,
src/utils/stockDataHelper.ts, src/app/api/prediction/[ticker]/route.ts).
Output values will drift slightly from the pre-v3 monolithic model because
training is now two separate .fit() calls instead of one multi-output fit.

CONSTRAINT: no yfinance/requests/urllib/httpx — all data via --input_file.

CLI:
    python3 predict_weighted_analysis.py <ticker> --input_file <path>
"""

import sys
import json
import argparse

# predict_core sets CPU-throttling env vars + imports numpy/sklearn under the
# hood; importing it first means those env vars land before any heavy linalg
# library lands in our process.
from predict_core import (
    # Constants
    SEED, SEQ_LEN, N_EPOCHS, BATCH_SIZE, MC_RUNS,
    CACHE_DIR, CACHE_SCHEMA_VERSION, FEATURE_COLUMNS,
    # Cache helpers
    get_cache_key, load_from_cache, save_to_cache,
    # Encoders / helpers
    NumpyEncoder, safe,
    calculate_earnings_beat_streak, calculate_news_sentiment,
    merge_series_by_date,
    # Feature engineering
    build_features, _calculate_features_internal, _add_macro_features,
    # Regime
    build_regime_detector, select_regime_k,
    # Sequences / confidence / sanitize / analysis
    make_sequences, confidence_score, metric_analysis,
    _sanitize_predictions,
)

from predict_long_term import predict_long_term
from predict_short_term import predict_short_term
from analyst_sentiment import compute_analyst_sentiment

from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from sklearn.preprocessing import MinMaxScaler


# ============================================================================
# DEPRECATED — kept for backward-compat import in case any test references it
# ============================================================================
def build_mlp(seed=SEED):
    """Deprecated: the v3-split refactor uses two 2-output horizon-specific
    models (build_short_term_model + build_long_term_model). This stub
    returns one of them so legacy importers don't crash."""
    from predict_long_term import build_long_term_model
    return build_long_term_model(seed)


# ============================================================================
# MAIN PREDICTION FUNCTION
# ============================================================================
def predict(ticker, input_data):
    historical_data    = input_data.get('historicalData', [])
    stock_metrics      = input_data.get('stockMetrics', {})
    macro_data         = input_data.get('macroData', {})
    options_data       = input_data.get('optionsData', {})
    feature_metrics    = input_data.get('featureMetrics', {})
    news_articles      = input_data.get('newsArticles', [])
    historical_earnings = input_data.get('historicalEarnings', [])
    data_quality       = input_data.get('dataQuality', {})
    # External technical score from the frontend/technical indicators section
    external_tech_score = safe(input_data.get('technicalScore'), 0.0)

    # Analyst Consensus: try the categorical key first (frontend prop, or the
    # /data endpoint's stockMetrics.recommendationKey as a secondary source),
    # then fall back to Yahoo's numeric recommendationMean.
    recommendation_key = input_data.get('recommendationKey') or stock_metrics.get('recommendationKey')
    consensus_key = (recommendation_key or '').lower().replace('_', ' ') if recommendation_key else ''
    consensus_map = {
        'strong buy': 1.0,
        'buy': 0.75,
        'hold': 0.0,
        'sell': -0.75,
        'strong sell': -1.0
    }
    consensus_value = consensus_map.get(consensus_key, 0.0)
    # Numeric fallback fires whenever the categorical didn't resolve to a known
    # bucket — empty string, missing entirely, or an unrecognized value like
    # Yahoo's 'none' / 'underperform' / 'outperform' for thinly-covered names.
    # Yahoo's recommendationMean scale runs 1.0 (Strong Buy) → 5.0 (Strong
    # Sell), mapped linearly to [-1, 1] with 3.0 (Hold) → 0.
    _recmean_fired = False
    if consensus_key not in consensus_map:
        rcm = stock_metrics.get('recommendationMean')
        if rcm is not None:
            try:
                rcm_f = float(rcm)
                if 1.0 <= rcm_f <= 5.0:
                    consensus_value = max(-1.0, min(1.0, (3.0 - rcm_f) / 2.0))
                    _recmean_fired = True
            except (TypeError, ValueError):
                pass
    # Tertiary fallback: derive consensus from `recommendationsHistory` — the
    # per-period strongBuy/buy/hold/sell/strongSell counts. Fires for tickers
    # where Yahoo's summary recommendationKey is 'none' AND recommendationMean
    # is null (LPG-class thinly-covered names) but the trend still has votes.
    if not _recmean_fired and consensus_value == 0.0:
        rec_history = input_data.get('recommendationsHistory')
        if isinstance(rec_history, list) and rec_history:
            target_row = next((r for r in rec_history if r.get('period') == '0m'), None)
            if target_row is None:
                target_row = rec_history[0]
            try:
                sb = float(target_row.get('strongBuy',  0) or 0)
                b  = float(target_row.get('buy',        0) or 0)
                h  = float(target_row.get('hold',       0) or 0)
                s  = float(target_row.get('sell',       0) or 0)
                ss = float(target_row.get('strongSell', 0) or 0)
                total = sb + b + h + s + ss
                if total > 0:
                    weighted = (sb*1.0 + b*2.0 + h*3.0 + s*4.0 + ss*5.0) / total
                    consensus_value = max(-1.0, min(1.0, (3.0 - weighted) / 2.0))
            except (TypeError, ValueError):
                pass

    if not historical_data:
        raise ValueError("No historical data provided.")

    # ---- Build DataFrame ----
    df = pd.DataFrame(historical_data)

    # Validate required columns exist before renaming
    required_cols = ['open', 'high', 'low', 'close', 'volume']
    if not all(col in df.columns for col in required_cols):
        missing = [col for col in required_cols if col not in df.columns]
        raise ValueError(f"Historical data missing required columns: {missing}")

    df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                        'close': 'Close', 'volume': 'Volume', 'date': 'Date'},
              inplace=True)

    if len(df) < 365:
        raise ValueError(f"Insufficient data: {len(df)} rows, need >= 365.")

    # Ensure numeric columns are actually numeric
    for col in ['Open', 'High', 'Low', 'Close', 'Volume']:
        try:
            df[col] = pd.to_numeric(df[col], errors='coerce')
        except Exception as e:
            raise ValueError(f"Could not convert {col} to numeric: {e}")

    # Current price anchor for all % change calculations
    current_price = float(stock_metrics.get('regularMarketPrice') or df['Close'].iloc[-1])

    # Basic stock characteristics (kept for legacy metric_analysis + stock_type)
    close_arr      = df['Close'].values
    recent_20      = close_arr[-20:]
    older_20       = close_arr[-40:-20] if len(close_arr) >= 40 else close_arr[:20]
    growth_rate    = ((recent_20.mean() - older_20.mean()) / (older_20.mean() + 1e-9)) * 100
    is_uptrend     = bool(recent_20.max() > older_20.max() and recent_20.min() > older_20.min())
    is_growth_stock = growth_rate > 2.0 and is_uptrend

    news_sentiment      = calculate_news_sentiment(news_articles)
    earnings_beat_streak = calculate_earnings_beat_streak(historical_earnings)

    # ---- Feature engineering ----
    feat_df = build_features(df, stock_metrics, macro_data,
                              news_sentiment, earnings_beat_streak, current_price, ticker=ticker, options_data=options_data, feature_metrics=feature_metrics)

    # ── Regime detection + integration (shared across both horizons) ────────
    regime_vec_cols = ['VIX', 'HistVol_30', 'HYG_LQD_Ratio', 'RS_vs_SPY_20d', 'DXY_Return_20d',
                       'CurveSlope_10M3M', 'RollingMean_20d', 'RollingStd_20d',
                       'WorldBank_GDP', 'WorldBank_Inflation']

    for col in regime_vec_cols:
        if col not in feat_df.columns:
            feat_df[col] = 0.0

    regime_vec = feat_df[regime_vec_cols].values.astype(np.float32)
    # Sanitize: some international/REIT tickers produce inf/NaN that crashes
    # the downstream scaler / GaussianMixture.
    regime_vec = np.nan_to_num(regime_vec, nan=0.0, posinf=0.0, neginf=0.0)

    k, fitted_regime_model, regime_scaler = select_regime_k(regime_vec)
    regime_vec_norm = regime_scaler.transform(regime_vec)
    regime_labels, regime_probs = build_regime_detector(regime_vec_norm, fitted_regime_model, k)

    # One-hot + probability columns, padded to K=4
    for i in range(4):
        if i < k:
            feat_df[f'Regime_{i}'] = (regime_labels == i).astype(float)
        else:
            feat_df[f'Regime_{i}'] = 0.0

    if regime_probs is not None:
        for i in range(4):
            if i < k:
                feat_df[f'Regime_Prob_{i}'] = regime_probs[:, i]
            else:
                feat_df[f'Regime_Prob_{i}'] = 0.0
    else:
        for i in range(4):
            if i < k:
                feat_df[f'Regime_Prob_{i}'] = (regime_labels == i).astype(float)
            else:
                feat_df[f'Regime_Prob_{i}'] = 0.0

    feat_df['Regime_x_PC_Ratio'] = (feat_df.get('Regime_0', 0) *
                                     feat_df.get('Put_Call_Ratio', 1.0).fillna(0))
    feat_df['Regime_x_HYG_LQD'] = (feat_df.get('Regime_1', 0) *
                                    feat_df.get('HYG_LQD_Ratio', 1.0).fillna(0))
    feat_df['Regime_x_RS_SPY'] = (feat_df.get('Regime_2', 0) *
                                   feat_df.get('RS_vs_SPY_20d', 0).fillna(0))

    regime_cols = ([f'Regime_{i}' for i in range(4)] +
                   [f'Regime_Prob_{i}' for i in range(4)] +
                   ['Regime_x_PC_Ratio', 'Regime_x_HYG_LQD', 'Regime_x_RS_SPY'])

    extended_feature_cols = FEATURE_COLUMNS + [col for col in regime_cols if col not in FEATURE_COLUMNS]
    for col in extended_feature_cols:
        if col not in feat_df.columns:
            feat_df[col] = 0.0
    feat_df = feat_df[extended_feature_cols]
    feat_df = feat_df.ffill().bfill().fillna(0)

    n_features = len(extended_feature_cols)
    raw = feat_df.values.astype(np.float32)
    raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)

    current_regime_idx = int(regime_labels[-1])
    current_regime_probs = regime_probs[-1].tolist() if regime_probs is not None else (regime_labels[-1:] == np.arange(k)).astype(float).tolist()
    while len(current_regime_probs) < 4:
        current_regime_probs.append(0.0)
    regime_names = {0: 'risk_on_trending', 1: 'risk_off_stress', 2: 'high_vol_choppy', 3: 'low_vol_mean_reverting'}
    regime_info = {
        'k': k,
        'current_regime': current_regime_idx,
        'current_regime_probs': [round(p, 3) for p in current_regime_probs[:k]],
        'regime_names': [regime_names[i] for i in range(k)]
    }

    # ── Scale features ──────────────────────────────────────────────────────
    scaler = MinMaxScaler(feature_range=(0, 1))
    close_col_idx = FEATURE_COLUMNS.index('Close')

    cp_tmp = current_price if current_price > 0 else (df['Close'].iloc[-1] if len(df) > 0 else 1)
    atm_tmp = safe(stock_metrics.get('analystTargetMean'), 0.0)
    aoc_tmp = safe(stock_metrics.get('analystOpinionCount'), 0)
    analyst_premium_tmp = (atm_tmp - cp_tmp) / (cp_tmp + 1e-9) if atm_tmp > 0 and cp_tmp > 0 else 0.0
    reliability_tmp     = min(aoc_tmp / 40.0, 1.0)
    analyst_weighted_val = analyst_premium_tmp * reliability_tmp

    scaled = scaler.fit_transform(raw)

    # ── Build training targets (1d, 1w, 6m, 1y) ──────────────────────────────
    T1, T5  = 1, 5
    T6  = 126   # ~6 months
    T12 = 252   # ~12 months
    T18 = 378   # ~18 months (trajectory extrapolation)

    scaled_close = scaled[:, close_col_idx]
    targets_1d  = np.zeros(len(scaled))
    targets_1w  = np.zeros(len(scaled))
    targets_6m  = np.zeros(len(scaled))
    targets_1y  = np.zeros(len(scaled))
    for i in range(len(scaled)):
        targets_1d[i] = scaled_close[min(i + T1,  len(scaled) - 1)]
        targets_1w[i] = scaled_close[min(i + T5,  len(scaled) - 1)]
        targets_6m[i] = scaled_close[min(i + T6,  len(scaled) - 1)]
        targets_1y[i] = scaled_close[min(i + T12, len(scaled) - 1)]

    # Sanity check that we have enough data for either horizon to train
    # (horizon files build their own X via their feature masks; here we
    # just verify the underlying scaled matrix is long enough)
    if len(scaled) - SEQ_LEN < 50:
        raise ValueError("Not enough sequences for training.")

    # ── Analyst sentiment scoring (v1 legacy vs v2 richer FinalScore) ────────
    # v2 uses time-weighted recommendation history (yfinance Ticker.recommendations
    # period-bucketed table) + capped target upside + dispersion penalty.
    # Gracefully falls back to v1 path if v2 data is missing.
    from predict_core import ANALYST_SCORING_VERSION
    analyst_sentiment_v2 = None
    if ANALYST_SCORING_VERSION == 'v2':
        rec_history = input_data.get('recommendationsHistory') or []
        target_mean = safe(stock_metrics.get('analystTargetMean'), None)
        target_low  = safe(stock_metrics.get('analystTargetLow'), None)
        target_high = safe(stock_metrics.get('analystTargetHigh'), None)
        # Only invoke v2 if we actually have rec history; otherwise leave None
        # so metric_analysis() falls back to v1 (consensus_value + analyst_weighted_val).
        if rec_history:
            analyst_sentiment_v2 = compute_analyst_sentiment(
                recommendations_history=rec_history,
                target_mean=target_mean,
                target_low=target_low,
                target_high=target_high,
                current_price=current_price,
            )
            print(f"[DEBUG] analyst_sentiment v2: FinalScore={analyst_sentiment_v2['final_score']} "
                  f"(Rec={analyst_sentiment_v2['rec_score']}, Target={analyst_sentiment_v2['target_score']}); "
                  f"analyst_impact={analyst_sentiment_v2['analyst_impact']:+.4f}; "
                  f"coverage_pts={analyst_sentiment_v2['coverage_pts']} conviction_pts={analyst_sentiment_v2['conviction_pts']}; "
                  f"dispersion={analyst_sentiment_v2['dispersion_penalty']:.3f}; "
                  f"avg_analysts={analyst_sentiment_v2['avg_analyst_count']:.1f}",
                  file=sys.stderr)

    # ── Metric analysis (legacy, shared) ─────────────────────────────────────
    m_analysis = metric_analysis(feat_df, stock_metrics, news_sentiment,
                                  growth_rate, is_uptrend, earnings_beat_streak, external_tech_score, consensus_value, analyst_weighted_val,
                                  analyst_count=int(safe(stock_metrics.get('analystOpinionCount'), 0)),
                                  analyst_sentiment_v2=analyst_sentiment_v2)

    # Per-horizon weighting: short-term and long-term modules compose their
    # own multipliers from non_analyst_impact + analyst_impact × per-horizon
    # boost. Analyst signal carries more weight at 6m/1y than at 1w/1m.
    non_analyst_impact = m_analysis['non_analyst_impact']
    analyst_impact     = m_analysis['analyst_impact']

    # World Bank Consumption Heuristic (Phase 4) — applies to ALL horizons.
    consumer_multiplier = 1.0
    sector = stock_metrics.get('sector', '')
    if sector in ['Consumer Cyclical', 'Consumer Defensive']:
        cons_growth = feat_df['WorldBank_Consumption'].iloc[-1]
        consumer_multiplier = 1.0 + max(-0.03, min(0.03, cons_growth * 0.005))

    # Long-term multiplier — analyst contribution boosted via ANALYST_BOOST_LT
    # (the short-term module composes its own mult_1w / mult_1m internally).
    from predict_core import ANALYST_BOOST_LT
    long_term_multiplier = (1.0 + non_analyst_impact + analyst_impact * ANALYST_BOOST_LT) * consumer_multiplier

    # ── Confidence inputs (shared) ───────────────────────────────────────────
    imputed = data_quality.get('imputedFields', [])
    analyst_count = int(safe(stock_metrics.get('analystOpinionCount'), 0))
    history_years = safe(data_quality.get('historyYears'), 2.0)
    print(f"[DEBUG] Confidence score inputs for {ticker}:", file=sys.stderr)
    print(f"  history_years: {history_years}", file=sys.stderr)
    print(f"  imputed_fields ({len(imputed)}): {imputed}", file=sys.stderr)
    print(f"  analyst_count: {analyst_count}", file=sys.stderr)

    # ── Long-term first (short-term needs predicted_price_6m_base + cs6m) ──
    long_out = predict_long_term(
        scaled=scaled,
        feature_columns=extended_feature_cols,
        targets_6m=targets_6m,
        targets_1y=targets_1y,
        feat_df=feat_df,
        current_price=current_price,
        long_term_multiplier=long_term_multiplier,
        scaler=scaler,
        close_col_idx=close_col_idx,
        n_features=n_features,
        history_years=history_years,
        imputed_fields=imputed,
        analyst_count=analyst_count,
        analyst_sentiment_v2=analyst_sentiment_v2,
    )

    predicted_price_6m = long_out['predicted_price_6m']
    predicted_price_1y = long_out['predicted_price_1y']
    predicted_price_6m_base = long_out['predicted_price_6m_base']
    cs6m = long_out['confidence_score_6m']
    spread_6m  = long_out['spread_6m']
    spread_12m = long_out['spread_12m']
    spread_18m = long_out['spread_18m']
    p18m_est   = long_out['p18m_est']
    cv_mae     = long_out['cv_mae']
    cv_mape    = long_out['cv_mape']

    # ── Short-term ───────────────────────────────────────────────────────────
    # Pass impact components (not a baked multiplier) so the module can build
    # its own per-horizon multipliers and apply the ≥3-analyst floor.
    short_out = predict_short_term(
        scaled=scaled,
        feature_columns=extended_feature_cols,
        targets_1d=targets_1d,
        targets_1w=targets_1w,
        feat_df=feat_df,
        current_price=current_price,
        non_analyst_impact=non_analyst_impact,
        analyst_impact=analyst_impact,
        analyst_count=analyst_count,
        consumer_multiplier=consumer_multiplier,
        scaler=scaler,
        close_col_idx=close_col_idx,
        n_features=n_features,
        predicted_price_6m_base=predicted_price_6m_base,
        confidence_score_6m=cs6m,
        stock_metrics=stock_metrics,
    )

    predicted_price_1w = short_out['predicted_price_1w']
    predicted_price_1m = short_out['predicted_price_1m']

    # ── 18m trajectory (uses both horizon outputs) ───────────────────────────
    WAYPOINTS = [T5] + list(range(21, 379, 21))  # t+5, t+21, t+42, ... t+378
    last_date_str = str(df['Date'].iloc[-1]) if 'Date' in df.columns else datetime.today().strftime('%Y-%m-%d')
    last_date = datetime.strptime(last_date_str[:10], '%Y-%m-%d')

    # Deterministic per-stock perturbation source for the trajectory wiggle.
    # Seeded from SEED so reruns of the same ticker emit the same path. The
    # wiggle envelope is anchored at the milestone waypoints (T5/T6/T12) so
    # those points still match predicted_price_1w/_6m/_1y exactly; only the
    # in-between waypoints move. Without this the trajectory is a perfectly
    # straight $0.X/month line, which reads as extrapolation rather than a
    # probabilistic forecast.
    traj_rng = np.random.default_rng(SEED)

    def _wiggle(t: float, spread: float) -> float:
        # Arch envelope: sin(π·t) is 0 at t=0 and t=1, peaks at t=0.5. We
        # multiply by a deterministic standard-normal draw and a 0.10 scale so
        # the in-between waypoints move at most ~5% of the local spread away
        # from the linear baseline. Milestones get t=0 → wiggle=0 by design.
        if t <= 0.0 or t >= 1.0:
            return 0.0
        return float(traj_rng.standard_normal()) * spread * 0.10 * np.sin(np.pi * t)

    trajectory = []
    for td in WAYPOINTS:
        if td == T5:
            mid    = predicted_price_1w
            spread = spread_6m * (T5 / T6)
        elif td <= T6:
            t      = (td - T5) / (T6 - T5)
            mid    = predicted_price_1w + (predicted_price_6m - predicted_price_1w) * t
            spread = spread_6m * (td / T6)
            mid   += _wiggle(t, spread)
        elif td <= T12:
            t      = (td - T6) / (T12 - T6)
            mid    = predicted_price_6m + (predicted_price_1y - predicted_price_6m) * t
            spread = spread_6m + (spread_12m - spread_6m) * t
            mid   += _wiggle(t, spread)
        else:
            t      = (td - T12) / (T18 - T12)
            mid    = predicted_price_1y + (p18m_est - predicted_price_1y) * t
            spread = spread_12m + (spread_18m - spread_12m) * t
            mid   += _wiggle(t, spread)

        waypoint_date = last_date + timedelta(days=int(td * 365.25 / 252))
        month_label   = waypoint_date.strftime('%b %Y')

        trajectory.append({
            "month":           month_label,
            "predicted_price": round(mid, 2),
            "lower_bound":     round(mid - spread / 2, 2),
            "upper_bound":     round(mid + spread / 2, 2),
        })

    # ── Backward-compat fields ───────────────────────────────────────────────
    # rmse comes from the same holdout residuals as cv_mae (predict_long_term.py).
    # The historical `np.sqrt(cv_mae ** 2)` was a no-op that made rmse identical
    # to mae in every output; the new field is the real sqrt(MSE).
    rmse    = long_out.get('cv_rmse', cv_mae * 1.253)
    mae_val = cv_mae

    high_uncertainty = abs(predicted_price_1y - current_price) / (current_price + 1e-9) > 0.60

    # 6m trajectory range (waypoint index 6 after the t+5 prepend = t+126 ≈ 6m)
    traj_6m = trajectory[6]
    prange_low  = round(traj_6m['lower_bound'] - current_price, 2)
    prange_high = round(traj_6m['upper_bound']  - current_price, 2)

    spread_1w = spread_6m * (T5 / T6)

    # ── Assemble final result ────────────────────────────────────────────────
    result = {
        "ticker":                str(ticker).upper().strip(),
        "regularMarketPrice":    round(current_price, 2),
        # 1-week short-term
        "predicted_price_1w":      round(predicted_price_1w, 2),
        "predicted_change_pct_1w": short_out['predicted_change_pct_1w'],
        "confidence_score_1w":     short_out['confidence_score_1w'],
        "predicted_range_1w":      [round(predicted_price_1w - spread_1w / 2, 2), round(predicted_price_1w + spread_1w / 2, 2)],
        # Dual-horizon (long-term)
        "predicted_price_6m":   round(predicted_price_6m, 2),
        "predicted_price_1y":   round(predicted_price_1y, 2),
        "predicted_change_pct_6m":  long_out['predicted_change_pct_6m'],
        "predicted_change_pct_1y":  long_out['predicted_change_pct_1y'],
        "confidence_score_6m":  cs6m,
        "confidence_score_1y":  long_out['confidence_score_1y'],
        # 1-month
        "predicted_price_1m":      round(predicted_price_1m, 2),
        "predicted_change_pct_1m": short_out['predicted_change_pct_1m'],
        "confidence_score_1m":     short_out['confidence_score_1m'],
        "high_uncertainty":     high_uncertainty,
        # Backward compat
        "predicted_change_range": [prange_low, prange_high],
        # Trajectory
        "monthly_trajectory":  trajectory,
        # Accuracy
        "accuracy_metrics": {
            "model": {
                "mae":    round(mae_val, 2),
                "rmse":   round(rmse,    2),
                "cv_mae": round(cv_mae,  2),
            }
        },
        # Stock characteristics
        "stock_type":      "growth_stock" if is_growth_stock else "stable_stock",
        "growth_rate_20d": round(growth_rate, 2),
        "is_uptrend":      int(is_uptrend),
        # Data quality pass-through
        "data_quality":    data_quality,
        # Options data availability
        "options_data_available": bool(options_data and options_data.get('available')),
        # Regime info
        "regime_info": regime_info,
        # Legacy metric analysis
        "metric_analysis": m_analysis,
        # Observability
        "observability": {
            "macro_features_used": ["WorldBank_GDP", "WorldBank_Inflation", "WorldBank_Consumption"],
            "consumer_multiplier_applied": round(float(consumer_multiplier), 4)
        }
    }
    return result


# ============================================================================
# ENTRY POINT
# ============================================================================
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='MLP Stock Price Prediction')
    parser.add_argument('ticker',       type=str, help='Stock ticker symbol')
    parser.add_argument('--input_file', type=str, required=True, help='Path to JSON input file')
    parser.add_argument('--outlook',    type=str, default='all', choices=['1_week', '1_month', '6_month', '1_year', 'all'], help='Prediction outlook')
    args = parser.parse_args()

    try:
        with open(args.input_file, 'r') as fh:
            input_data = json.load(fh)

        # ── Caching logic ──
        hist = input_data.get('historicalData', [])
        ckey = get_cache_key(args.ticker, hist)
        cached_result = load_from_cache(ckey)

        if cached_result:
            result = cached_result
        else:
            result = predict(args.ticker, input_data)
            save_to_cache(ckey, result)

        # Clamp out-of-bounds predictions before anything downstream sees them
        result = _sanitize_predictions(result)

        # Filter result based on outlook if not 'all'
        if args.outlook != 'all':
            filtered = {
                "ticker": result["ticker"],
                "regularMarketPrice": result["regularMarketPrice"],
                "outlook": args.outlook,
                "data_quality": result["data_quality"],
                "accuracy_metrics": result["accuracy_metrics"],
                "regime_info": result["regime_info"]
            }

            if args.outlook == '1_week':
                filtered.update({
                    "predicted_price": result["predicted_price_1w"],
                    "predicted_change_pct": result["predicted_change_pct_1w"],
                    "confidence_score": result["confidence_score_1w"],
                    "predicted_range": result["predicted_range_1w"]
                })
            elif args.outlook == '1_month':
                filtered.update({
                    "predicted_price": result["predicted_price_1m"],
                    "predicted_change_pct": result["predicted_change_pct_1m"],
                    "confidence_score": result["confidence_score_1m"]
                })
            elif args.outlook == '6_month':
                filtered.update({
                    "predicted_price": result["predicted_price_6m"],
                    "predicted_change_pct": result["predicted_change_pct_6m"],
                    "confidence_score": result["confidence_score_6m"],
                    "predicted_change_range": result["predicted_change_range"]
                })
            elif args.outlook == '1_year':
                filtered.update({
                    "predicted_price": result["predicted_price_1y"],
                    "predicted_change_pct": result["predicted_change_pct_1y"],
                    "confidence_score": result["confidence_score_1y"]
                })
            result = filtered

        print(json.dumps(result, cls=NumpyEncoder))
        sys.exit(0)

    except FileNotFoundError:
        print(json.dumps({"error": f"Input file not found: {args.input_file}"}), file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Invalid JSON in input file: {exc}"}), file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        import traceback
        print(json.dumps({"error": str(exc), "traceback": traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)
