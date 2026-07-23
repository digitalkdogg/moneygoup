"""
predict_light.py — Fast CS-model pre-filter for the deepmoney analyzer.

Reads a batch of ticker payloads (same format as predict_weighted_analysis.py),
builds feat_df for each using predict_core helpers, runs the pre-trained
long_term_cs_v2.pkl for a quick 6m return estimate, and emits pass/fail per
ticker.

No Monte Carlo noise. No per-ticker MLP training. No TF/Keras. ~50-200ms
per ticker in a single subprocess, vs ~8-15s per ticker for full MC.

Fail-open: any ticker that errors during scoring is returned with passed=true
so bugs here never silently kill the discovery pipeline.

Usage:
    python3 scripts/predict_light.py --input-file /tmp/light_input.json

Input JSON schema:
    {
      "threshold": 0.0,          # float: minimum 6m predicted % change to pass
      "candidates": [
        { "ticker": "AAPL", "payload": { <same as predict_weighted_analysis.py> } },
        ...
      ]
    }

Output JSON schema:
    {
      "results": {
        "AAPL": { "passed": true,  "predicted_change_pct_6m": 12.3, "error": null },
        "MSFT": { "passed": false, "predicted_change_pct_6m": -2.1, "error": null }
      },
      "passed_count":   1,
      "filtered_count": 1
    }
"""
import os
import sys
import json
import argparse
from pathlib import Path

# CPU throttling before numpy/sklearn import — matches predict_core.py
os.environ['OMP_NUM_THREADS']        = '1'
os.environ['MKL_NUM_THREADS']        = '1'
os.environ['OPENBLAS_NUM_THREADS']   = '1'
os.environ['VECLIB_MAXIMUM_THREADS'] = '1'
os.environ['NUMEXPR_NUM_THREADS']    = '1'
try:
    os.nice(15)
except Exception:
    pass

import numpy as np
import pandas as pd

# Reuse the same feature-building and regime-detection machinery the full
# prediction pipeline uses. This guarantees predict_light.py and
# predict_weighted_analysis.py see identical feature representations.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from predict_core import (
    build_features,
    select_regime_k,
    build_regime_detector,
    calculate_news_sentiment,
    calculate_earnings_beat_streak,
)

MODELS_DIR         = Path(__file__).parent.parent / 'models'
CS_MODEL_PATH      = MODELS_DIR / 'long_term_cs_v2.pkl'
CALIBRATION_SCALAR = 0.55  # v5 regression-to-mean: scales final pct after post-hoc fixes

# ── Load CS model once at process startup ─────────────────────────────────────
_CS_MODEL = None
try:
    import joblib
    if CS_MODEL_PATH.exists():
        _CS_MODEL = joblib.load(CS_MODEL_PATH)
        n_feats = len(_CS_MODEL.get('feature_columns', []))
        print(f"[predict_light] CS model loaded: {n_feats} features, "
              f"trained_at {_CS_MODEL.get('trained_at', '?')}", file=sys.stderr)
    else:
        print(f"[predict_light] WARN: CS model not found at {CS_MODEL_PATH}", file=sys.stderr)
except Exception as exc:
    print(f"[predict_light] WARN: CS model load failed: {exc}", file=sys.stderr)


def _isnan(v) -> bool:
    try:
        return bool(np.isnan(v))
    except (TypeError, ValueError):
        return False


def _predict_one(ticker: str, input_data: dict, threshold: float) -> dict:
    """
    Score one ticker with the CS model.
    Returns { passed, predicted_change_pct_6m, error }.
    Fail-open: any exception → passed=True so the pipeline stays alive.
    """
    if _CS_MODEL is None:
        return {'passed': True, 'predicted_change_pct_6m': 0.0, 'error': 'cs_model_not_loaded'}

    try:
        historical_data     = input_data.get('historicalData', [])
        stock_metrics       = input_data.get('stockMetrics', {})
        macro_data          = input_data.get('macroData', {})
        options_data        = input_data.get('optionsData', {})
        feature_metrics     = input_data.get('featureMetrics', {})
        news_articles       = input_data.get('newsArticles', [])
        historical_earnings = input_data.get('historicalEarnings', [])

        if not historical_data or len(historical_data) < 100:
            return {'passed': True, 'predicted_change_pct_6m': 0.0, 'error': 'insufficient_history'}

        df = pd.DataFrame(historical_data)
        required_cols = ['open', 'high', 'low', 'close', 'volume']
        if not all(col in df.columns for col in required_cols):
            return {'passed': True, 'predicted_change_pct_6m': 0.0, 'error': 'missing_ohlcv_cols'}

        df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                            'close': 'Close', 'volume': 'Volume', 'date': 'Date'},
                  inplace=True)
        for col in ['Open', 'High', 'Low', 'Close', 'Volume']:
            df[col] = pd.to_numeric(df[col], errors='coerce')

        current_price = float(
            stock_metrics.get('regularMarketPrice') or df['Close'].iloc[-1]
        )

        news_sentiment       = calculate_news_sentiment(news_articles)
        earnings_beat_streak = calculate_earnings_beat_streak(historical_earnings)

        feat_df = build_features(
            df, stock_metrics, macro_data,
            news_sentiment, earnings_beat_streak, current_price,
            ticker=ticker,
            options_data=options_data,
            feature_metrics=feature_metrics,
        )

        # ── Regime detection — mirrors predict_weighted_analysis.py exactly ──
        regime_vec_cols = [
            'VIX', 'HistVol_30', 'HYG_LQD_Ratio', 'RS_vs_SPY_20d', 'DXY_Return_20d',
            'CurveSlope_10M3M', 'RollingMean_20d', 'RollingStd_20d',
            'WorldBank_GDP', 'WorldBank_Inflation',
        ]
        for col in regime_vec_cols:
            if col not in feat_df.columns:
                feat_df[col] = 0.0

        regime_vec = feat_df[regime_vec_cols].values.astype(np.float32)
        regime_vec = np.nan_to_num(regime_vec, nan=0.0, posinf=0.0, neginf=0.0)

        k, fitted_regime_model, regime_scaler = select_regime_k(regime_vec)
        regime_vec_norm = regime_scaler.transform(regime_vec)
        regime_labels, regime_probs = build_regime_detector(
            regime_vec_norm, fitted_regime_model, k
        )

        for i in range(4):
            feat_df[f'Regime_{i}'] = (regime_labels == i).astype(float) if i < k else 0.0

        if regime_probs is not None:
            for i in range(4):
                feat_df[f'Regime_Prob_{i}'] = regime_probs[:, i] if i < k else 0.0
        else:
            for i in range(4):
                feat_df[f'Regime_Prob_{i}'] = (regime_labels == i).astype(float) if i < k else 0.0

        feat_df['Regime_x_PC_Ratio'] = (
            feat_df.get('Regime_0', 0) *
            feat_df.get('Put_Call_Ratio', 1.0).fillna(0)
        )
        feat_df['Regime_x_HYG_LQD'] = (
            feat_df.get('Regime_1', 0) *
            feat_df.get('HYG_LQD_Ratio', 1.0).fillna(0)
        )
        feat_df['Regime_x_RS_SPY'] = (
            feat_df.get('Regime_2', 0) *
            feat_df.get('RS_vs_SPY_20d', 0).fillna(0)
        )

        # ── CS model inference ────────────────────────────────────────────────
        cs_feature_cols = _CS_MODEL['feature_columns']
        model           = _CS_MODEL['model']
        scaler_cs       = _CS_MODEL['scaler']

        current_row = feat_df.iloc[-1]
        x_current = np.array([
            float(current_row[col])
            if col in feat_df.columns and not _isnan(current_row[col])
            else 0.0
            for col in cs_feature_cols
        ], dtype=np.float32).reshape(1, -1)
        x_current = np.nan_to_num(x_current, nan=0.0, posinf=0.0, neginf=0.0)
        x_current_s = scaler_cs.transform(x_current)

        # pred_returns = [return_126d, return_252d] (raw return fractions, not %)
        pred_returns = model.predict(x_current_s)[0]
        pct_6m = float(pred_returns[0]) * 100.0

        # ── v4 drift + v5 Fix A/C/D + 0.55 calibration scalar ────────────────
        close_arr = [row['close'] for row in historical_data]
        beta = float(stock_metrics.get('beta') or 1.0)
        predicted_price = current_price * (1.0 + pct_6m / 100.0)

        ret30d = (close_arr[-1] / close_arr[-22] - 1.0) if len(close_arr) >= 22 else 0.0
        ret90d = (close_arr[-1] / close_arr[-64] - 1.0) if len(close_arr) >= 64 else 0.0

        # v4 momentum drift — fires when |90d return| > 15%
        if abs(ret90d) > 0.15:
            predicted_price *= (1.0 + ret90d * 0.75)

        # Fix A — downtrend trap ceiling
        if beta > 0.8 and ret30d < -0.05 and ret90d < -0.10:
            severity = min(1.0, (-ret90d - 0.10) / 0.25)
            cap = 1.0 - (severity * 0.08 * min(beta, 2.0) / 2.0)
            predicted_price = min(predicted_price, current_price * cap)

        # Fix C — structural decline override
        hi_52w = max((row['high'] for row in historical_data[-252:]), default=0.0)
        if hi_52w > 0:
            pct_from_52w = close_arr[-1] / hi_52w - 1.0
            if pct_from_52w < -0.20 and ret90d < -0.15:
                decline_sev = min(1.0, (-pct_from_52w - 0.20) / 0.30)
                f6m = 1.0 - (0.05 + decline_sev * 0.05)
                predicted_price = min(predicted_price, current_price * f6m)

        # Fix D — extreme positive momentum amplifier
        if ret90d > 0.30:
            xtscale = 1.0 + min(0.50, (ret90d - 0.30) * 2.0)
            predicted_price = current_price + (predicted_price - current_price) * xtscale

        # Calibration scalar — squeezes magnitude toward zero (reduces overconfidence)
        raw_pct = (predicted_price - current_price) / current_price * 100.0
        pct_6m = round(raw_pct * CALIBRATION_SCALAR, 2)

        return {
            'passed':                  pct_6m >= threshold,
            'predicted_change_pct_6m': pct_6m,
            'error':                   None,
        }

    except Exception as exc:
        print(f"[predict_light] {ticker}: scoring error: {exc}", file=sys.stderr)
        return {'passed': True, 'predicted_change_pct_6m': 0.0, 'error': str(exc)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-file', required=True)
    args = parser.parse_args()

    with open(args.input_file) as fh:
        batch = json.load(fh)

    threshold  = float(batch.get('threshold', 0.0))
    candidates = batch.get('candidates', [])

    results        = {}
    passed_count   = 0
    filtered_count = 0

    for c in candidates:
        ticker = c['ticker']
        result = _predict_one(ticker, c.get('payload', {}), threshold)
        results[ticker] = result
        verdict = 'passed' if result['passed'] else 'filtered'
        if result['passed']:
            passed_count += 1
        else:
            filtered_count += 1
        print(
            f"[predict_light] {verdict} {ticker}: "
            f"6m={result['predicted_change_pct_6m']}%",
            file=sys.stderr,
        )

    print(json.dumps({
        'results':        results,
        'passed_count':   passed_count,
        'filtered_count': filtered_count,
    }))


if __name__ == '__main__':
    main()
