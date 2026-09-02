"""
predict_weighted_analysis.py — MLP-based stock price prediction (v5).

This file is the orchestrator. Shared logic lives in predict_core.py;
horizon-specific models + post-processing live in predict_short_term.py
(1w/1m) and predict_long_term.py (6m/1y).

The MODEL_VARIANT env var gates which fix stack is applied:
  v3 — bare model output (control; no post-hoc adjustments)
  v4 — VIX-conf mult + direction deadband + RSI-beta gate + 90d drift
  v5 — v4 base (minus VIX-conf mult) + Fix A/B/C/D
       Default. Set MODEL_VARIANT=v3 or v4 to reproduce older behavior.

v5 adjustments (in order):
  Fix B  — Beta-signed VIX modifier on long_term_multiplier. Low-beta names
           (β<0.5) get a boost in high VIX (flight-to-quality); high-beta names
           get a softer dampener than v4 (starts at VIX=25, floors at 0.55).
           Applied BEFORE predict_long_term so it flows into the 6m/1y price.
  #4     — 90d momentum drift (v4, unchanged). Fires when |90d return| > 15%.
  Fix A  — Downtrend trap ceiling. High-beta names (β>0.8) with both 30d < -5%
           and 90d < -10% get a downside price ceiling.
  Fix C  — Structural decline. >20% below 52w high AND 90d < -15% triggers a
           continued-slow-decline prediction (5-10% down at 6m, 8-15% at 1y).
  Fix D  — Extreme positive momentum. When 90d > 30%, scale the predicted
           move delta by up to 1.5× to counter the model's mean-reversion bias
           in the extreme-momentum tail.
  Deadband — <2% predicted move ⇒ predicted_direction_{h} = 'neutral' (v4).
  RSI-beta — Overbought RSI (>70) boosts/dampens 1w/1m confidence by beta (v4).

  NOTE: Fixes E, F, G were tested in a v5-efg-newset backtest (see
  reports/data_4way_newset.txt) but showed no meaningful improvement and were
  reverted. The comments here reflect the stable v5 A/B/C/D-only stack.

The CLI contract and output JSON schema are preserved (callers:
scripts/update_predictions.py, scripts/backtest/run_backtest.py,
src/utils/stockDataHelper.ts, src/app/api/prediction/[ticker]/route.ts).

CONSTRAINT: no yfinance/requests/urllib/httpx — all data via --input_file.

CLI:
    python3 predict_weighted_analysis.py <ticker> --input_file <path>
"""

import os
import sys
import json
import argparse

# long_term_cs_v2 was trained with 11 one-hot sector columns (see
# models/long_term_cs_v2_manifest.json) that build_features()/extended_feature_cols
# don't produce — that pipeline only serves the short/medium-term model.
# Names match Yahoo Finance's 11 sector strings, lowercased with underscores.
SECTOR_ONEHOT_COLS = [
    'sector_basic_materials', 'sector_communication_services',
    'sector_consumer_cyclical', 'sector_consumer_defensive', 'sector_energy',
    'sector_financial_services', 'sector_healthcare', 'sector_industrials',
    'sector_real_estate', 'sector_technology', 'sector_utilities',
]

# Variant gate for A/B testing the post-hoc fix stack.
#   'v3'  — no post-hoc adjustments (bare model output; useful as a control)
#   'v4'  — VIX-conf mult + direction deadband + RSI-beta gate + 90d drift
#   'v5'  — v4 base (minus VIX-conf mult) + Fix A/B/C/D
# Default is v5 so new deployments get the current fix stack out of the box.
_MODEL_VARIANT = os.getenv('MODEL_VARIANT', 'v5').lower()
if _MODEL_VARIANT not in ('v3', 'v4', 'v5'):
    print(f"[warn] MODEL_VARIANT={_MODEL_VARIANT!r} not recognized; defaulting to v5", file=sys.stderr)
    _MODEL_VARIANT = 'v5'

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
    compute_precedent_confidence,
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

    if len(df) < 200:
        raise ValueError(f"Insufficient data: {len(df)} rows, need >= 200.")

    # Ensure numeric columns are actually numeric
    for col in ['Open', 'High', 'Low', 'Close', 'Volume']:
        try:
            df[col] = pd.to_numeric(df[col], errors='coerce')
        except Exception as e:
            raise ValueError(f"Could not convert {col} to numeric: {e}")

    # Forward-fill zero/negative Close prices — yfinance occasionally inserts
    # 0.0 on corporate-action dates (spinoffs, splits, re-listings). A single
    # zero makes ret30d/ret90d/HiRatio_52w compute as -100%, which triggers
    # Fix A/C incorrectly and produces wildly wrong predictions.
    _bad_close = (df['Close'] <= 0) | df['Close'].isna()
    if _bad_close.any():
        print(f"[warn] {ticker}: {_bad_close.sum()} zero/NaN close price(s) — forward-filling",
              file=sys.stderr)
        df['Close'] = df['Close'].replace(to_replace=0, value=np.nan)
        df['Close'] = df['Close'].where(df['Close'] > 0)
        df['Close'] = df['Close'].ffill().bfill()

    # Current price anchor for all % change calculations
    current_price = float(stock_metrics.get('regularMarketPrice') or df['Close'].iloc[-1])

    # Basic stock characteristics (kept for legacy metric_analysis + stock_type)
    close_arr      = df['Close'].values

    # Realized annualized volatility from 60d of log returns. Feeds the
    # sanitizer's vol-scaled per-horizon caps so a high-vol name (WULF ≈ 90%
    # annualized) doesn't trip the ceiling on every prediction that a stable
    # 30%-vol name would consider extreme. Falls back to 0.30 when there's
    # not enough history to compute.
    if len(close_arr) >= 62:
        _prices_62 = close_arr[-62:]
        if np.all(_prices_62 > 0):
            _log_ret = np.log(_prices_62[1:] / _prices_62[:-1])
            _vol_candidate = float(np.std(_log_ret) * np.sqrt(252))
            realized_vol_60d = _vol_candidate if (0 < _vol_candidate < 10.0) else 0.30
        else:
            realized_vol_60d = 0.30
    else:
        realized_vol_60d = 0.30

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

    # CS-model regime interaction features — must mirror train_long_term_cs_v2.py
    feat_df['VIX_x_HYG_LQD']   = feat_df.get('VIX', 0) * feat_df.get('HYG_LQD_Ratio', 0)
    feat_df['VIX_x_CurveSlope'] = feat_df.get('VIX', 0) * feat_df.get('CurveSlope_10M3M', 0)
    feat_df['HYG_x_RS_SPY']     = feat_df.get('HYG_LQD_Ratio', 0) * feat_df.get('RS_vs_SPY_20d', 0)
    feat_df['VIX_x_HistVol60']  = feat_df.get('VIX', 0) * feat_df.get('HistVol_60', 0)

    regime_cols = ([f'Regime_{i}' for i in range(4)] +
                   [f'Regime_Prob_{i}' for i in range(4)] +
                   ['Regime_x_PC_Ratio', 'Regime_x_HYG_LQD', 'Regime_x_RS_SPY',
                    'VIX_x_HYG_LQD', 'VIX_x_CurveSlope', 'HYG_x_RS_SPY', 'VIX_x_HistVol60'])

    extended_feature_cols = FEATURE_COLUMNS + [col for col in regime_cols if col not in FEATURE_COLUMNS]
    for col in extended_feature_cols:
        if col not in feat_df.columns:
            feat_df[col] = 0.0
    feat_df = feat_df[extended_feature_cols]
    feat_df = feat_df.ffill().bfill().fillna(0)

    n_features = len(extended_feature_cols)
    raw = feat_df.values.astype(np.float32)
    raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)

    # Added after `raw`/n_features are finalized so it can't perturb the
    # short/medium-term model's input shape — predict_long_term() looks these
    # up by name via cs_feature_cols, not positionally against extended_feature_cols.
    _sector_col = 'sector_' + str(stock_metrics.get('sector', '') or '').strip().lower().replace(' ', '_')
    for _col in SECTOR_ONEHOT_COLS:
        feat_df[_col] = 1.0 if _col == _sector_col else 0.0

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

    # ── Build training targets (1d, 1w, 3m, 6m) ──────────────────────────────
    T1, T5  = 1, 5
    T1M = 21    # ~1 month  (anchor for trajectory wiggle suppression)
    T3M = 63    # ~3 months (new long-term model first head)
    T6  = 126   # ~6 months (long-term model second head)
    T9M = 189   # ~9 months (trajectory extrapolation endpoint)

    scaled_close = scaled[:, close_col_idx]
    targets_1d  = np.zeros(len(scaled))
    targets_1w  = np.zeros(len(scaled))
    targets_3m  = np.zeros(len(scaled))
    targets_6m  = np.zeros(len(scaled))
    for i in range(len(scaled)):
        targets_1d[i] = scaled_close[min(i + T1,  len(scaled) - 1)]
        targets_1w[i] = scaled_close[min(i + T5,  len(scaled) - 1)]
        targets_3m[i] = scaled_close[min(i + T3M, len(scaled) - 1)]
        targets_6m[i] = scaled_close[min(i + T6,  len(scaled) - 1)]

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

    # ── WRS composite grade (v3 — from frontend, 0-100) ─────────────────────
    # The frontend computes a WRS-based composite (5-step algorithm) and sends
    # it as analystGradeScore. Blend 50/50 with v2 final_score when both are
    # present; build a minimal v2-compatible dict when v2 is absent.
    wrs_grade_score = safe(input_data.get('analystGradeScore'), None)
    if wrs_grade_score is not None:
        wrs_grade_score = float(max(0.0, min(100.0, wrs_grade_score)))
        import math as _math
        if analyst_sentiment_v2 is not None:
            blended = 0.5 * analyst_sentiment_v2['final_score'] + 0.5 * wrs_grade_score
            # Recompute analyst_impact from the blended score (same formula as v2).
            reliability = analyst_sentiment_v2.get('_reliability', None)
            avg_count = analyst_sentiment_v2.get('avg_analyst_count', 0.0)
            if reliability is None:
                from analyst_sentiment import RELIABILITY_FLOOR, RELIABILITY_SATURATION
                reliability = RELIABILITY_FLOOR + (1.0 - RELIABILITY_FLOOR) * _math.sqrt(
                    min(avg_count / RELIABILITY_SATURATION, 1.0)
                )
            normalized = (blended - 50.0) / 50.0
            from analyst_sentiment import MAX_ANALYST_IMPACT
            blended_impact = normalized * MAX_ANALYST_IMPACT * reliability * (
                1.0 - analyst_sentiment_v2.get('dispersion_penalty', 0.0)
            )
            analyst_sentiment_v2 = {**analyst_sentiment_v2,
                                     'final_score': blended,
                                     'analyst_impact': blended_impact}
        else:
            # No v2 data — build minimal dict from WRS score alone.
            normalized = (wrs_grade_score - 50.0) / 50.0
            from analyst_sentiment import MAX_ANALYST_IMPACT
            analyst_sentiment_v2 = {
                'final_score':        wrs_grade_score,
                'rec_score':          wrs_grade_score,
                'target_score':       wrs_grade_score,
                'analyst_impact':     normalized * MAX_ANALYST_IMPACT,
                'coverage_pts':       0,
                'conviction_pts':     0,
                'dispersion_penalty': 0.0,
                'avg_analyst_count':  0.0,
            }
        print(f"[DEBUG] analyst WRS grade={wrs_grade_score:.1f} → blended final_score={analyst_sentiment_v2['final_score']:.1f} "
              f"analyst_impact={analyst_sentiment_v2['analyst_impact']:+.4f}", file=sys.stderr)

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

    # ── v5 Fix B: Beta-signed VIX modifier on long_term_multiplier ──────────
    # Low-beta defensives (β<0.5) get a *boost* in high VIX (flight-to-quality
    # makes their direction more predictable, not less). High-beta names get a
    # softer dampener than v4's confidence-only version: threshold VIX=25
    # instead of 20, scale over 35 pts instead of 30, floored at 0.55 so we
    # never fully suppress the return prediction. Only active in variant v5.
    if _MODEL_VARIANT == 'v5':
        _vix_now = float(feat_df['VIX'].iloc[-1]) if 'VIX' in feat_df.columns else 20.0
        _beta_b  = float(safe(stock_metrics.get('beta'), 1.0))
        if _beta_b < 0.5:
            _vix_mod = 1.0 + max(0.0, (_vix_now - 20.0) / 30.0) * 0.15
        else:
            _vix_raw = 1.0 - max(0.0, (_vix_now - 25.0) / 35.0) * (_beta_b / 1.5)
            _vix_mod = max(0.55, _vix_raw)
        long_term_multiplier = long_term_multiplier * _vix_mod

    # ── Confidence inputs (shared) ───────────────────────────────────────────
    imputed = data_quality.get('imputedFields', [])
    analyst_count = int(safe(stock_metrics.get('analystOpinionCount'), 0))
    history_years = safe(data_quality.get('historyYears'), 2.0)
    print(f"[DEBUG] Confidence score inputs for {ticker}:", file=sys.stderr)
    print(f"  history_years: {history_years}", file=sys.stderr)
    print(f"  imputed_fields ({len(imputed)}): {imputed}", file=sys.stderr)
    print(f"  analyst_count: {analyst_count}", file=sys.stderr)

    # Stash per-ticker context on the DataFrame's attrs so the long-term CS
    # path can (a) look up a persisted per-ticker cv_mape by ticker key and
    # (b) fall back to a realized-vol proxy when the inference-time backtest
    # isn't feasible. feat_df already exists and travels straight through.
    try:
        feat_df.attrs['ticker']            = str(ticker).upper().strip()
        feat_df.attrs['realized_vol_60d']  = realized_vol_60d
    except Exception:
        pass

    # ── Long-term first (short-term needs predicted_price_3m_base + cs3m) ──
    long_out = predict_long_term(
        scaled=scaled,
        feature_columns=extended_feature_cols,
        targets_3m=targets_3m,
        targets_6m=targets_6m,
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

    predicted_price_3m = long_out['predicted_price_3m']
    predicted_price_6m = long_out['predicted_price_6m']
    predicted_price_3m_base = long_out['predicted_price_3m_base']
    cs3m = long_out['confidence_score_3m']
    sig3m = long_out.get('signal_confidence_3m', cs3m)
    spread_3m  = long_out['spread_3m']
    spread_6m  = long_out['spread_6m']
    spread_9m  = long_out['spread_9m']
    p9m_est    = long_out['p9m_est']
    cv_mae     = long_out['cv_mae']
    cv_mape    = long_out['cv_mape']

    # ── v4/v5 long-horizon price adjustments (order matters) ────────────────
    # Shared inputs: 30d and 90d trading-day returns from the raw close array.
    # These are computed once and reused by Fixes A/C/D + the v4 momentum drift.
    v_telemetry = {'variant': _MODEL_VARIANT}
    if _MODEL_VARIANT in ('v4', 'v5'):
        _ret30d = float(close_arr[-1] / close_arr[-22] - 1.0) if len(close_arr) >= 22 else 0.0
        _ret90d = float(close_arr[-1] / close_arr[-64] - 1.0) if len(close_arr) >= 64 else 0.0
        _beta   = float(safe(stock_metrics.get('beta'), 1.0))
        v_telemetry.update({'ret30d': round(_ret30d, 4), 'ret90d': round(_ret90d, 4), 'beta': round(_beta, 3)})

        # v4 Fix #4 — 90d momentum drift (|mom| > 15%). Fires in v4 AND v5.
        # Fix D (v5) extends this for the extreme-momentum tail.
        if abs(_ret90d) > 0.15 and current_price > 0:
            _drift_3m = _ret90d * 0.50
            _drift_6m = _ret90d * 0.75
            predicted_price_3m = current_price + (predicted_price_3m - current_price) * (1.0 + _drift_3m)
            predicted_price_6m = current_price + (predicted_price_6m - current_price) * (1.0 + _drift_6m)
            v_telemetry['v4_drift_3m'] = round(_drift_3m, 4)
            v_telemetry['v4_drift_6m'] = round(_drift_6m, 4)

        # ── v5 Fix A: Downtrend Trap ────────────────────────────────────────
        # High-beta names in a sustained decline (30d < -5% AND 90d < -10%)
        # get a downside ceiling applied to 3m/6m targets. Beta-scaled so β=2
        # stocks get a bigger cap than β=1 stocks. Excludes low-beta defensives
        # (JNJ/KO/PG) which genuinely mean-revert after dips.
        if _MODEL_VARIANT == 'v5' and _beta > 0.8 and _ret30d < -0.05 and _ret90d < -0.10:
            _severity = min(1.0, (-_ret90d - 0.10) / 0.25)
            _cap = 1.0 - (_severity * 0.08 * min(_beta, 2.0) / 2.0)
            predicted_price_3m = current_price + (predicted_price_3m - current_price) * _cap
            predicted_price_6m = current_price + (predicted_price_6m - current_price) * (_cap - 0.03)
            v_telemetry['fixA_severity'] = round(_severity, 3)
            v_telemetry['fixA_cap']      = round(_cap, 4)
            print(f"[v5] {ticker} Fix A fired: beta={_beta:.2f} ret30d={_ret30d:.2%} "
                  f"ret90d={_ret90d:.2%} → cap={_cap:.3f}", file=sys.stderr)

        # ── v5 Fix C: Structural Decline ────────────────────────────────────
        # >20% below 52w high AND still falling (90d < -15%): predict continued
        # slow decline rather than recovery. The double gate (depth + recency)
        # prevents misfiring on crash-then-recovery cases (e.g. AAPL April 2025).
        if _MODEL_VARIANT == 'v5':
            _hi_ratio = float(feat_df['HiRatio_52w'].iloc[-1]) if 'HiRatio_52w' in feat_df.columns else 1.0
            _pct_from_52w = _hi_ratio - 1.0
            if _pct_from_52w < -0.20 and _ret90d < -0.15:
                _decline_sev = min(1.0, (-_pct_from_52w - 0.20) / 0.30)
                _f3m = 1.0 - (0.03 + _decline_sev * 0.04)
                _f6m = 1.0 - (0.05 + _decline_sev * 0.05)
                predicted_price_3m = current_price + (predicted_price_3m - current_price) * _f3m
                predicted_price_6m = current_price + (predicted_price_6m - current_price) * _f6m
                v_telemetry['fixC_pct_from_52w'] = round(_pct_from_52w, 3)
                v_telemetry['fixC_severity']     = round(_decline_sev, 3)
                print(f"[v5] {ticker} Fix C fired: pct_from_52w={_pct_from_52w:.2%} "
                      f"ret90d={_ret90d:.2%} sev={_decline_sev:.2f} → f3m={_f3m:.3f} f6m={_f6m:.3f}",
                      file=sys.stderr)

        # ── v5 Fix D: Extreme Positive Momentum ─────────────────────────────
        # Extends v4 drift for the tail case (90d > 30%). Scales the predicted
        # move delta (not the absolute price) so we amplify the direction of
        # the model's call rather than pushing the price toward an arbitrary
        # level. Mutually exclusive with Fix A/C by sign of ret90d.
        #
        # Guardrail: suppress in structural downtrends. A 30%+ 90d bounce in a
        # stock down 20%+ over the year (or 35%+ below its 52w high) is a
        # counter-trend move — amplifying it pushes predictions bullish while
        # the underlying trend remains firmly down (observed concretely: CELH
        # held bounces of this magnitude multiple times during a sustained
        # multi-year collapse, producing 0% 1w direction accuracy under Fix D).
        if _MODEL_VARIANT == 'v5' and _ret90d > 0.30 and current_price > 0:
            _ret1y = (float(close_arr[-1] / close_arr[-252] - 1.0)
                      if len(close_arr) >= 252 else 0.0)
            _fixD_suppressed = (_ret1y < -0.20) or (_pct_from_52w < -0.35)
            if _fixD_suppressed:
                v_telemetry['fixD_suppressed'] = True
                v_telemetry['fixD_ret1y']      = round(_ret1y, 4)
                print(f"[v5] {ticker} Fix D SUPPRESSED (structural downtrend): "
                      f"ret90d={_ret90d:.2%} ret1y={_ret1y:.2%} "
                      f"pct_from_52w={_pct_from_52w:.2%}", file=sys.stderr)
            else:
                _excess  = _ret90d - 0.30
                _extra   = min(0.50, _excess * 2.0)
                _xtscale = 1.0 + _extra
                predicted_price_3m = current_price + (predicted_price_3m - current_price) * _xtscale
                predicted_price_6m = current_price + (predicted_price_6m - current_price) * _xtscale
                v_telemetry['fixD_xtscale'] = round(_xtscale, 4)
                print(f"[v5] {ticker} Fix D fired: ret90d={_ret90d:.2%} → xtscale={_xtscale:.3f}",
                      file=sys.stderr)

        # Sync predicted_change_pct fields so the result dict stays consistent
        if current_price > 0:
            long_out['predicted_change_pct_3m'] = round((predicted_price_3m - current_price) / current_price * 100, 4)
            long_out['predicted_change_pct_6m'] = round((predicted_price_6m - current_price) / current_price * 100, 4)

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
        predicted_price_3m_base=predicted_price_3m_base,
        confidence_score_3m=cs3m,
        stock_metrics=stock_metrics,
        signal_confidence_3m=sig3m,
    )

    predicted_price_1w = short_out['predicted_price_1w']
    predicted_price_1m = short_out['predicted_price_1m']

    # Pre-clamp short-horizon prices before the trajectory loop. _sanitize_predictions
    # (called after the result dict is assembled) would fix the scalar fields, but the
    # trajectory array is built here and never re-sanitized, so a billion-dollar CS
    # extrapolation would survive into monthly_trajectory[1].lower/upper_bound. Mirror
    # the same vol-scaled bounds used in _sanitize_predictions so the clamp is consistent.
    if current_price > 0:
        _vol_mult  = max(1.0, min(2.5, realized_vol_60d / 0.30))
        predicted_price_1w = max(current_price * (1 - 0.15 * _vol_mult),
                                 min(current_price * (1 + 0.15 * _vol_mult), predicted_price_1w))
        predicted_price_1m = max(current_price * (1 - 0.30 * _vol_mult),
                                 min(current_price * (1 + 0.30 * _vol_mult), predicted_price_1m))

    # ── 9m trajectory (uses both horizon outputs) ────────────────────────────
    WAYPOINTS = [T5] + list(range(21, 190, 21))  # t+5, t+21, t+42, ... t+189
    last_date_str = str(df['Date'].iloc[-1]) if 'Date' in df.columns else datetime.today().strftime('%Y-%m-%d')
    last_date = datetime.strptime(last_date_str[:10], '%Y-%m-%d')

    # Deterministic per-stock perturbation source for the trajectory wiggle.
    # Seeded from SEED so reruns of the same ticker emit the same path. The
    # wiggle envelope is anchored at the milestone waypoints (T5/T1M/T6/T12) so
    # those points still match predicted_price_1w/_1m/_6m/_1y exactly; only the
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
            spread = spread_3m * (T5 / T3M)
        elif td == T1M:
            mid    = predicted_price_1m
            spread = spread_3m * (T1M / T3M)
        elif td <= T3M:
            t      = (td - T5) / (T3M - T5)
            mid    = predicted_price_1w + (predicted_price_3m - predicted_price_1w) * t
            spread = spread_3m * (td / T3M)
            mid   += _wiggle(t, spread)
        elif td <= T6:
            t      = (td - T3M) / (T6 - T3M)
            mid    = predicted_price_3m + (predicted_price_6m - predicted_price_3m) * t
            spread = spread_3m + (spread_6m - spread_3m) * t
            mid   += _wiggle(t, spread)
        else:
            t      = (td - T6) / (T9M - T6)
            mid    = predicted_price_6m + (p9m_est - predicted_price_6m) * t
            spread = spread_6m + (spread_9m - spread_6m) * t
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

    high_uncertainty = abs(predicted_price_6m - current_price) / (current_price + 1e-9) > 0.60

    # 6m trajectory range (waypoint index 6 after the t+5 prepend = t+126 ≈ 6m)
    traj_6m = trajectory[6]
    prange_low  = round(traj_6m['lower_bound'] - current_price, 2)
    prange_high = round(traj_6m['upper_bound']  - current_price, 2)

    spread_1w = spread_3m * (T5 / T3M)

    # ── Assemble final result ────────────────────────────────────────────────
    result = {
        "ticker":                str(ticker).upper().strip(),
        "regularMarketPrice":    round(current_price, 2),
        # 1-week short-term
        "predicted_price_1w":          round(predicted_price_1w, 2),
        "predicted_price_1w_raw":      short_out.get('predicted_price_1w_raw'),
        "predicted_change_pct_1w":     short_out['predicted_change_pct_1w'],
        "predicted_change_pct_1w_raw": short_out.get('predicted_change_pct_1w_raw'),
        "confidence_score_1w":         short_out['confidence_score_1w'],
        "direction_confidence_1w":     short_out.get('direction_confidence_1w'),
        "direction_signal_1w":         short_out.get('direction_signal_1w'),
        "mlp_1w_base_raw":             short_out.get('mlp_1w_base_raw'),
        "traj_anchor_1w_base":         short_out.get('traj_anchor_1w_base'),
        "short_term_path":             short_out.get('short_term_path'),
        "predicted_range_1w":          [round(predicted_price_1w - spread_1w / 2, 2), round(predicted_price_1w + spread_1w / 2, 2)],
        # Dual-horizon (long-term)
        "predicted_price_3m":   round(predicted_price_3m, 2),
        "predicted_price_6m":   round(predicted_price_6m, 2),
        "predicted_change_pct_3m":  long_out['predicted_change_pct_3m'],
        "predicted_change_pct_6m":  long_out['predicted_change_pct_6m'],
        "confidence_score_3m":  cs3m,
        "confidence_score_6m":  long_out['confidence_score_6m'],
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
        # Realized annualized vol (60d log returns) — consumed by _sanitize_predictions
        # to scale the per-horizon clamp bounds. Kept in the response for
        # observability so a future dashboard can show it.
        "realized_vol_60d": round(realized_vol_60d, 4),
        # Confidence breakdown — component points + raw inputs so the UI can
        # explain WHY a Medium/Low confidence score is what it is (which
        # component is docking, and in plain terms). All four horizon scores
        # derive from this single breakdown with horizon-specific modifiers
        # (1w = cs1m+3, 1m = cs6m±10 based on earnings proximity, 1y = cs6m-15).
        "confidence_breakdown": long_out.get('confidence_breakdown'),
        # Signal confidence (MC ensemble agreement + CV MAPE — model-internal certainty)
        "signal_confidence_1w": short_out.get('signal_confidence_1w'),
        "signal_confidence_1m": short_out.get('signal_confidence_1m'),
        "signal_confidence_3m": long_out.get('signal_confidence_3m'),
        "signal_confidence_6m": long_out.get('signal_confidence_6m'),
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
    result = _apply_variant_adjustments(result, feat_df, current_price, stock_metrics,
                                         inline_telemetry=v_telemetry if _MODEL_VARIANT in ('v4', 'v5') else None)

    # ── Precedent confidence (Item 1) ─────────────────────────────────────────
    # Computed after _apply_variant_adjustments so we use the final (adjusted)
    # predicted_change_pct values. Uses historical closes already in feat_df.
    _closes = feat_df['Close'].values if 'Close' in feat_df.columns else np.array([current_price])
    _prec_1w = compute_precedent_confidence(_closes, result.get('predicted_change_pct_1w', 0.0), 5)
    _prec_1m = compute_precedent_confidence(_closes, result.get('predicted_change_pct_1m', 0.0), 21)
    _prec_3m = compute_precedent_confidence(_closes, result.get('predicted_change_pct_3m', 0.0), 63)
    _prec_6m = compute_precedent_confidence(_closes, result.get('predicted_change_pct_6m', 0.0), 126)
    result['precedent_confidence_1w'] = _prec_1w
    result['precedent_confidence_1m'] = _prec_1m
    result['precedent_confidence_3m'] = _prec_3m
    result['precedent_confidence_6m'] = _prec_6m

    # Blended confidence (0.7 signal + 0.3 precedent) — single value for sort/filter.
    _sc_1m = result.get('signal_confidence_1m') or result.get('confidence_score_1m', 65)
    result['blended_confidence_1m'] = int(round(0.7 * _sc_1m + 0.3 * _prec_1m))

    # ── Sector / industry conviction gate (#3) ────────────────────────────────
    # Scale confidence scores based on sector/industry historical direction
    # accuracy. Does not affect predicted prices — only how confident we say we
    # are. Tune multipliers after running the industry-segmented backtest.
    #
    # Industry overrides take precedence over sector fallbacks.
    # Weak  industries → multiplier < 1 (chronically near 50% direction acc)
    # Strong industries → multiplier > 1 (historically outperform coin flip)
    _INDUSTRY_CONFIDENCE_SCALE = {
        # Weak — growth/binary-event names, hard to predict short-medium term
        'Software Infrastructure':              0.88,
        'Internet Content & Information':       0.88,
        'Drug Manufacturers—General':           0.88,
        'Drug Manufacturers—Specialty & Generic': 0.88,
        'Biotechnology':                        0.88,
        # Strong — rate-driven / stable-demand, model features naturally suited
        'Banks—Regional':                       1.08,
        'Banks—Diversified':                    1.08,
        'Beverages—Non-Alcoholic':              1.08,
        'Beverages—Brewers':                    1.06,
        'Healthcare Plans':                     1.08,
        'Insurance—Life':                       1.05,
        'Insurance—Property & Casualty':        1.05,
        'Utilities—Regulated Electric':         1.06,
        'Utilities—Regulated Gas':              1.06,
    }
    _SECTOR_CONFIDENCE_SCALE = {
        'Technology':             0.93,
        'Communication Services': 0.93,
        'Financial Services':     1.05,
        'Consumer Defensive':     1.05,
        'Utilities':              1.05,
        # All other sectors: 1.0 (no adjustment)
    }
    _s_industry = stock_metrics.get('industry', '') or ''
    _s_sector   = stock_metrics.get('sector', '')   or ''
    _conf_scale = _INDUSTRY_CONFIDENCE_SCALE.get(
        _s_industry, _SECTOR_CONFIDENCE_SCALE.get(_s_sector, 1.0)
    )
    if _conf_scale != 1.0:
        for _hk in ('confidence_score_1w', 'confidence_score_1m',
                    'confidence_score_3m', 'confidence_score_6m'):
            _v = result.get(_hk)
            if _v is not None:
                result[_hk] = int(round(max(1, min(100, _v * _conf_scale))))
        result['blended_confidence_1m'] = int(round(
            max(1, min(100, result['blended_confidence_1m'] * _conf_scale))
        ))
        result['sector_confidence_scale'] = round(_conf_scale, 3)
    # ─────────────────────────────────────────────────────────────────────────

    # Note: LLM rationale is generated in the CLI main block (not here) so it
    # runs on every prediction — even cache hits — and can be regenerated
    # without invalidating the entire prediction cache. See __main__ below.
    return result


# ============================================================================
# POST-HOC OUTPUT-LEVEL ADJUSTMENTS (deadband + short-term confidence)
# ============================================================================
# Price-level fixes (v4 drift, v5 A/B/C/D) run inline inside predict() so
# Fix D can compose with the v4 drift and Fix A can compose with Fix C. This
# function handles the output-level fixes that don't touch predicted_price
# but do touch predicted_direction_{h} and confidence_score_{h}.
V4_DEADBAND_PCT     = 0.02   # |Δ| < 2% ⇒ predicted_direction = 'neutral'
V4_DEADBAND_BY_HORIZON = {'1w': 0.02, '1m': 0.02, '3m': 0.02, '6m': 0.02}
V4_VIX_BASELINE     = 20.0   # VIX at/below this ⇒ no confidence nerf (v4 only)
V4_VIX_STRESS_SCALE = 30.0   # (vix - 20) / 30 ⇒ 1.0 stress at VIX=50 (v4 only)
V4_BETA_BASELINE    = 1.5    # beta at this level ⇒ full stress absorption (v4 only)
V4_RSI_OVERBOUGHT   = 70
V4_HIGH_BETA        = 0.8
V4_LOW_BETA         = 0.5
V4_RSI_BOOST_HB     = 1.10   # high-beta OB ⇒ boost 1w/1m confidence
V4_RSI_DAMP_LB      = 0.85   # low-beta OB ⇒ damp 1w/1m confidence


def _apply_variant_adjustments(result: dict, feat_df, current_price: float,
                                stock_metrics: dict, inline_telemetry=None) -> dict:
    """Apply the output-level fixes that don't touch predicted_price:
      • v4/v5 direction deadband — writes predicted_direction_{h} ∈ up/down/neutral
      • v4 VIX-beta confidence multiplier — REMOVED in v5 (replaced by Fix B on
        long_term_multiplier); still applied in v4 for A/B comparison.
      • v4/v5 RSI-gated short-term confidence — 1w/1m only.

    In v3, no adjustments run — predicted_direction_{h} is still written for
    downstream compatibility but derived directly from the raw predicted_price
    without any deadband."""
    variant = _MODEL_VARIANT
    try:
        vix = float(feat_df['VIX'].iloc[-1])
    except Exception:
        vix = V4_VIX_BASELINE
    try:
        beta = float(feat_df['Beta'].iloc[-1])
    except Exception:
        beta = float(stock_metrics.get('beta') or 1.0)
    try:
        rsi = float(feat_df['RSI_14'].iloc[-1])
    except Exception:
        rsi = 50.0

    telemetry = dict(inline_telemetry) if inline_telemetry else {'variant': variant}
    telemetry.update({'vix': round(vix, 2), 'rsi_14d': round(rsi, 1)})

    # ── Direction deadband (v4 + v5) ────────────────────────────────────────
    # In v3, we still populate predicted_direction_{h} but without the deadband
    # (any non-zero predicted move ⇒ up/down; exactly-flat ⇒ neutral).
    for h in ('1w', '1m', '3m', '6m'):
        if variant in ('v4', 'v5'):
            _deadband = V4_DEADBAND_BY_HORIZON.get(h, V4_DEADBAND_PCT)
        else:
            _deadband = 0.0
        pp = result.get(f'predicted_price_{h}')
        if not (isinstance(pp, (int, float)) and current_price and current_price > 0):
            result[f'predicted_direction_{h}'] = 'neutral'
            continue
        change = (pp - current_price) / current_price
        if abs(change) < _deadband:
            result[f'predicted_direction_{h}'] = 'neutral'
        elif change > 0:
            result[f'predicted_direction_{h}'] = 'up'
        else:
            result[f'predicted_direction_{h}'] = 'down'

    # ── v4-only VIX × beta confidence nerf ──────────────────────────────────
    # In v5 this is replaced by Fix B on long_term_multiplier (see predict()).
    if variant == 'v4':
        stress = max(0.0, (vix - V4_VIX_BASELINE) / V4_VIX_STRESS_SCALE)
        beta_absorb = max(0.0, beta) / V4_BETA_BASELINE
        vix_conf_mult = max(0.0, 1.0 - stress * beta_absorb)
        if vix_conf_mult < 1.0:
            for h in ('1w', '1m', '3m', '6m'):
                k = f'confidence_score_{h}'
                v = result.get(k)
                if isinstance(v, (int, float)):
                    result[k] = round(v * vix_conf_mult, 2)
            telemetry['vix_conf_mult'] = round(vix_conf_mult, 4)

    # ── RSI-gated short-term confidence (v4 + v5) ───────────────────────────
    if variant in ('v4', 'v5') and rsi > V4_RSI_OVERBOUGHT:
        factor = None
        if beta > V4_HIGH_BETA:
            factor = V4_RSI_BOOST_HB
        elif beta < V4_LOW_BETA:
            factor = V4_RSI_DAMP_LB
        if factor is not None:
            for h in ('1w', '1m'):
                k = f'confidence_score_{h}'
                v = result.get(k)
                if isinstance(v, (int, float)):
                    result[k] = round(min(100.0, v * factor), 2)
            telemetry['rsi_beta_factor'] = factor

    result['variant_adjustments'] = telemetry
    return result


# ============================================================================
# ENTRY POINT
# ============================================================================
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='MLP Stock Price Prediction')
    parser.add_argument('ticker',       type=str, help='Stock ticker symbol')
    parser.add_argument('--input_file', type=str, required=True, help='Path to JSON input file')
    parser.add_argument('--outlook',    type=str, default='all', choices=['1_week', '1_month', '3_month', '6_month', 'all'], help='Prediction outlook')
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

        # LLM narration is now async (Plan 2): route.ts fires /narrate on the
        # warm service (or scripts/generate_rationale.py on the spawn path)
        # after the prediction response is returned to the user, so narration
        # never holds a semaphore slot.  Setting None here is safe — the UI
        # falls back to confidence_reason_{h} strings until the DB backfill
        # from the async narration job completes.
        result['llm_rationale'] = None

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
            elif args.outlook == '3_month':
                filtered.update({
                    "predicted_price": result["predicted_price_3m"],
                    "predicted_change_pct": result["predicted_change_pct_3m"],
                    "confidence_score": result["confidence_score_3m"],
                })
            elif args.outlook == '6_month':
                filtered.update({
                    "predicted_price": result["predicted_price_6m"],
                    "predicted_change_pct": result["predicted_change_pct_6m"],
                    "confidence_score": result["confidence_score_6m"],
                    "predicted_change_range": result["predicted_change_range"]
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
