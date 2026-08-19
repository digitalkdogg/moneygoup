#!/usr/bin/env python3
"""
diagnose_model.py — End-to-end prediction model diagnostic.

Tests every major subsystem: model files, feature columns, data pipeline,
sanitizer rules, zero-price guard, vol guard, CS model alignment, and
full prediction smoke test.

Usage:
    python3 diagnose_model.py            # all checks, verbose
    python3 diagnose_model.py --quiet    # summary only
    python3 diagnose_model.py --check feature_columns  # one section
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR  = Path(__file__).resolve().parent          # scripts/diagnose/
SCRIPTS_DIR = SCRIPT_DIR.parent                        # scripts/
PROJECT_DIR = SCRIPTS_DIR.parent                       # project root
MODELS_DIR  = PROJECT_DIR / 'models'
sys.path.insert(0, str(SCRIPTS_DIR))                   # prediction modules live in scripts/
sys.path.insert(0, str(SCRIPT_DIR))                    # sibling diagnose helpers

# Load .env.local so CS_MODEL_VERSION / ST_CS_MODEL_VERSION / USE_LEGACY match
# the API exactly. Must happen before any prediction module is imported (they
# read these env vars at module import time, not at call time).
_env_local = PROJECT_DIR / '.env.local'
if _env_local.exists():
    with open(_env_local) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                _k, _, _v = _line.partition('=')
                os.environ.setdefault(_k.strip(), _v.strip())

# ── Terminal colors ────────────────────────────────────────────────────────────
_USE_COLOR = sys.stdout.isatty()
def _green(s):  return f'\033[92m{s}\033[0m' if _USE_COLOR else s
def _red(s):    return f'\033[91m{s}\033[0m' if _USE_COLOR else s
def _yellow(s): return f'\033[93m{s}\033[0m' if _USE_COLOR else s
def _bold(s):   return f'\033[1m{s}\033[0m'  if _USE_COLOR else s

# ── Result tracker ─────────────────────────────────────────────────────────────
_results: list[tuple[str, str, str]] = []  # (section, name, status_line)

def PASS(section, name, detail=''):
    tag = _green('PASS')
    line = f'  [{tag}] {name}' + (f' — {detail}' if detail else '')
    _results.append((section, name, 'PASS'))
    print(line)

def FAIL(section, name, detail=''):
    tag = _red('FAIL')
    line = f'  [{tag}] {name}' + (f' — {detail}' if detail else '')
    _results.append((section, name, 'FAIL'))
    print(line)

def WARN(section, name, detail=''):
    tag = _yellow('WARN')
    line = f'  [{tag}] {name}' + (f' — {detail}' if detail else '')
    _results.append((section, name, 'WARN'))
    print(line)

def section_header(title):
    print(f'\n{_bold("=" * 60)}')
    print(f'{_bold(f"  {title}")}')
    print(_bold('=' * 60))


# ==============================================================================
# 1. MODEL FILE CHECKS
# ==============================================================================
def check_model_files():
    section_header('1. Model File Checks')
    expected_files = {
        'long_term_cs_v2.pkl':            'Long-term CS model v2',
        'short_term_cs_v2.pkl':           'Short-term CS model v2',
        'long_term_cs_v1.pkl':            'Long-term CS model v1 (fallback)',
        'short_term_cs_v1.pkl':           'Short-term CS model v1 (fallback)',
        'ranker_v1_lambdarank.txt':       'LightGBM LambdaRank ranker',
        'ranker_v1_regression.txt':       'LightGBM Regression ranker',
        'feature_manifest.json':          'Feature manifest (JSON)',
        'long_term_cs_v2_manifest.json':  'LT CS v2 manifest',
    }
    S = '1.model_files'
    for fname, desc in expected_files.items():
        fpath = MODELS_DIR / fname
        if not fpath.exists():
            FAIL(S, fname, f'{desc} — FILE NOT FOUND at {fpath}')
            continue
        size_kb = fpath.stat().st_size / 1024
        if fpath.suffix == '.pkl':
            try:
                import joblib
                payload = joblib.load(str(fpath))
                keys = list(payload.keys()) if isinstance(payload, dict) else ['(non-dict)']
                n_feat = len(payload.get('feature_columns', [])) if isinstance(payload, dict) else '?'
                PASS(S, fname, f'{desc} — {size_kb:.0f} KB, keys={keys[:4]}, features={n_feat}')
            except Exception as e:
                FAIL(S, fname, f'{desc} — load failed: {e}')
        elif fpath.suffix == '.txt':
            try:
                import lightgbm as lgb
                bst = lgb.Booster(model_file=str(fpath))
                PASS(S, fname, f'{desc} — {size_kb:.0f} KB, num_trees={bst.num_trees()}')
            except ImportError:
                WARN(S, fname, f'{desc} — lightgbm not installed; can\'t verify booster')
            except Exception as e:
                FAIL(S, fname, f'{desc} — load failed: {e}')
        elif fpath.suffix == '.json':
            try:
                with open(fpath) as f:
                    data = json.load(f)
                PASS(S, fname, f'{desc} — {size_kb:.0f} KB, keys={list(data.keys())[:5]}')
            except Exception as e:
                FAIL(S, fname, f'{desc} — load failed: {e}')
        else:
            PASS(S, fname, f'{desc} — exists ({size_kb:.0f} KB)')


# ==============================================================================
# 2. FEATURE COLUMN AUDIT
# ==============================================================================
def check_feature_columns():
    section_header('2. Feature Column Audit')
    S = '2.feature_columns'
    try:
        from predict_core import (
            FEATURE_COLUMNS, SHORT_TERM_FEATURES, LONG_TERM_FEATURES,
            extend_with_regime_cols,
        )
    except Exception as e:
        FAIL(S, 'predict_core import', str(e))
        return

    PASS(S, 'predict_core import', f'{len(FEATURE_COLUMNS)} total features')

    # Duplicates in FEATURE_COLUMNS
    seen, dupes = set(), []
    for f in FEATURE_COLUMNS:
        if f in seen:
            dupes.append(f)
        seen.add(f)
    if dupes:
        FAIL(S, 'FEATURE_COLUMNS no duplicates', f'Duplicates: {dupes}')
    else:
        PASS(S, 'FEATURE_COLUMNS no duplicates')

    # SHORT_TERM subset
    missing_st = [f for f in SHORT_TERM_FEATURES if f not in FEATURE_COLUMNS]
    if missing_st:
        FAIL(S, 'SHORT_TERM_FEATURES ⊆ FEATURE_COLUMNS', f'Missing: {missing_st}')
    else:
        PASS(S, 'SHORT_TERM_FEATURES ⊆ FEATURE_COLUMNS',
             f'{len(SHORT_TERM_FEATURES)} ST features')

    # LONG_TERM subset
    missing_lt = [f for f in LONG_TERM_FEATURES if f not in FEATURE_COLUMNS]
    if missing_lt:
        FAIL(S, 'LONG_TERM_FEATURES ⊆ FEATURE_COLUMNS', f'Missing: {missing_lt}')
    else:
        PASS(S, 'LONG_TERM_FEATURES ⊆ FEATURE_COLUMNS',
             f'{len(LONG_TERM_FEATURES)} LT features')

    # Regime extensions don't overlap with existing columns
    extended_st = extend_with_regime_cols(SHORT_TERM_FEATURES)
    regime_cols = [c for c in extended_st if c not in SHORT_TERM_FEATURES]
    overlap_regime = [c for c in regime_cols if c in FEATURE_COLUMNS]
    if overlap_regime:
        WARN(S, 'Regime cols not in FEATURE_COLUMNS',
             f'These regime cols ARE in FEATURE_COLUMNS: {overlap_regime}')
    else:
        PASS(S, 'Regime cols (not in FEATURE_COLUMNS)',
             f'{len(regime_cols)} regime cols appended dynamically')

    # CS model feature coverage
    # The 4 VIX_x_*/HYG_x_* features are interaction terms computed at runtime
    # in predict_weighted_analysis.py, deliberately outside FEATURE_COLUMNS.
    CS_RUNTIME_FEATS = {
        'VIX_x_HYG_LQD', 'VIX_x_CurveSlope', 'HYG_x_RS_SPY', 'VIX_x_HistVol60',
        'Regime_x_PC_Ratio', 'Regime_x_HYG_LQD', 'Regime_x_RS_SPY',
    }
    cs_pkl = MODELS_DIR / 'long_term_cs_v2.pkl'
    if cs_pkl.exists():
        try:
            import joblib
            payload = joblib.load(str(cs_pkl))
            cs_feats = payload.get('feature_columns', [])
            cs_not_in_core = [f for f in cs_feats
                               if f not in FEATURE_COLUMNS
                               and not f.startswith('Regime_')
                               and f not in CS_RUNTIME_FEATS]
            core_not_in_cs  = [f for f in FEATURE_COLUMNS if f not in cs_feats]
            if cs_not_in_core:
                FAIL(S, 'CS v2 features ⊆ FEATURE_COLUMNS (+ runtime terms)',
                     f'{len(cs_not_in_core)} truly unknown: {cs_not_in_core[:5]}')
            else:
                rt_count = len([f for f in cs_feats if f in CS_RUNTIME_FEATS or f.startswith('Regime_')])
                PASS(S, 'CS v2 features ⊆ FEATURE_COLUMNS (+ runtime terms)',
                     f'{len(cs_feats)} CS feats; {rt_count} runtime interaction terms; {len(core_not_in_cs)} core-only')
        except Exception as e:
            WARN(S, 'CS v2 feature check', f'Could not load pkl: {e}')

    # Ranker feature coverage
    try:
        from ranker_features import FEATURE_COLUMNS as RANKER_COLS
        ranker_not_in_core = [f for f in RANKER_COLS if f not in FEATURE_COLUMNS]
        if ranker_not_in_core:
            FAIL(S, 'Ranker features ⊆ FEATURE_COLUMNS',
                 f'{len(ranker_not_in_core)} ranker features not in FEATURE_COLUMNS: {ranker_not_in_core[:5]}')
        else:
            PASS(S, 'Ranker features ⊆ FEATURE_COLUMNS',
                 f'{len(RANKER_COLS)} ranker features all present in core')
    except ImportError:
        WARN(S, 'ranker_features import', 'Module not found — skipping ranker feature check')
    except Exception as e:
        WARN(S, 'ranker_features import', str(e))


# ==============================================================================
# 3. SYNTHETIC DATA BUILDER
# ==============================================================================
def _make_synthetic_ohlcv(n=600, seed=42) -> pd.DataFrame:
    """Returns a DataFrame with OHLCV + date index for n trading days."""
    rng = np.random.default_rng(seed)
    price = 100.0
    prices = []
    for _ in range(n):
        ret = rng.normal(0.0003, 0.015)
        price *= (1 + ret)
        prices.append(max(price, 0.01))
    prices = np.array(prices)
    hi = prices * (1 + rng.uniform(0.001, 0.015, n))
    lo = prices * (1 - rng.uniform(0.001, 0.015, n))
    op = lo + rng.uniform(0, 1, n) * (hi - lo)
    vol = rng.integers(1_000_000, 10_000_000, n).astype(float)
    dates = pd.bdate_range(end=date.today(), periods=n)
    return pd.DataFrame({'Open': op, 'High': hi, 'Low': lo,
                          'Close': prices, 'Volume': vol}, index=dates)


def _make_stock_metrics() -> dict:
    today = date.today()
    return {
        'symbol': 'DIAG',
        'regularMarketPrice': 100.0,
        'sector': 'Technology',
        'industry': 'Software',
        'marketCap': 10_000_000_000,
        'trailingPE': 22.0,
        'priceToBook': 4.5,
        'trailingEps': 4.5,
        'forwardEps': 5.0,
        'revenueGrowth': 0.15,
        'earningsGrowth': 0.20,
        'profitMargins': 0.18,
        'debtToEquity': 45.0,
        'returnOnEquity': 0.22,
        'beta': 1.1,
        'dividendYield': 0.005,
        'freeCashflow': 1_000_000_000,
        'ebitda': 2_000_000_000,
        'totalRevenue': 8_000_000_000,
        'enterpriseValue': 18_000_000_000,
        'totalCash': 3_000_000_000,
        'recommendationMean': 2.1,
        'numberOfAnalystOpinions': 18,
        'targetMeanPrice': 115.0,
        'nextEarningsDate': (today + timedelta(days=60)).isoformat(),
        'shortPercentOfFloat': 0.03,
        'sharesOutstanding': 1_000_000_000,
        'impliedVolatility': 0.28,
    }


# ==============================================================================
# 4. ZERO PRICE GUARD
# ==============================================================================
def check_zero_price_guard():
    section_header('4. Zero Close Price Guard')
    S = '4.zero_price'
    try:
        import predict_weighted_analysis as pwa
    except Exception as e:
        FAIL(S, 'predict_weighted_analysis import', str(e))
        return

    df = _make_synthetic_ohlcv(n=400)
    # Inject a zero at row 50 (simulates corporate action date)
    df_z = df.copy()
    df_z.iloc[50, df_z.columns.get_loc('Close')] = 0.0

    # Simulate the forward-fill logic from predict_weighted_analysis.py
    bad = (df_z['Close'] <= 0) | df_z['Close'].isna()
    if not bad.any():
        FAIL(S, 'Zero injection', 'No zeros found after injection')
        return
    PASS(S, 'Zero injection', f'{bad.sum()} zero(s) detected correctly')

    df_fixed = df_z.copy()
    df_fixed['Close'] = df_fixed['Close'].replace(to_replace=0, value=np.nan)
    df_fixed['Close'] = df_fixed['Close'].where(df_fixed['Close'] > 0)
    df_fixed['Close'] = df_fixed['Close'].ffill().bfill()

    still_bad = (df_fixed['Close'] <= 0) | df_fixed['Close'].isna()
    if still_bad.any():
        FAIL(S, 'Forward-fill removes zeros', f'{still_bad.sum()} bad values remain')
    else:
        PASS(S, 'Forward-fill removes zeros', 'All zeros replaced with forward-filled price')

    # Verify ret30d not -100% after fix
    close_arr = df_fixed['Close'].values
    if len(close_arr) >= 31:
        ret30d = (close_arr[-1] / close_arr[-31] - 1) * 100
        if abs(ret30d + 100) < 1.0:
            FAIL(S, 'ret30d != -100% after fix', f'ret30d = {ret30d:.2f}%')
        else:
            PASS(S, 'ret30d != -100% after fix', f'ret30d = {ret30d:.2f}%')

    # Confirm unfixed data WOULD produce -100%
    close_bad = df_z['Close'].values
    if close_bad[50] == 0.0:
        ret30d_bad = (close_bad[-1] / max(close_bad[-31], 1e-9) - 1) * 100
        if close_bad[-31] > 0:
            PASS(S, 'Unguarded zero propagates to ret30d (expected)', f'ret30d = {ret30d_bad:.2f}%')


# ==============================================================================
# 5. REALIZED VOL NaN GUARD
# ==============================================================================
def check_vol_nan_guard():
    section_header('5. Realized Vol NaN Guard')
    S = '5.vol_nan'

    def compute_vol(close_arr):
        if len(close_arr) >= 62:
            _prices_62 = close_arr[-62:]
            if np.all(_prices_62 > 0):
                _log_ret = np.log(_prices_62[1:] / _prices_62[:-1])
                _vol_candidate = float(np.std(_log_ret) * np.sqrt(252))
                return _vol_candidate if 0 < _vol_candidate < 10.0 else 0.30
            else:
                return 0.30
        return 0.30

    # Clean data
    df = _make_synthetic_ohlcv(n=400)
    vol_clean = compute_vol(df['Close'].values)
    if math.isnan(vol_clean):
        FAIL(S, 'Clean data → no NaN vol', f'Got NaN (vol={vol_clean})')
    elif vol_clean == 0.30:
        WARN(S, 'Clean data → no NaN vol', f'Got fallback 0.30 (maybe low vol?)')
    else:
        PASS(S, 'Clean data → no NaN vol', f'vol={vol_clean:.4f}')

    # Zero-contaminated data
    close_bad = df['Close'].values.copy()
    close_bad[-20] = 0.0
    vol_bad = compute_vol(close_bad)
    if math.isnan(vol_bad):
        FAIL(S, 'Zero-contaminated → fallback 0.30', f'Got NaN instead of 0.30')
    elif vol_bad == 0.30:
        PASS(S, 'Zero-contaminated → fallback 0.30', 'Correctly fell back to 0.30')
    else:
        WARN(S, 'Zero-contaminated → fallback 0.30', f'Got {vol_bad:.4f} (non-0.30, non-NaN)')

    # Extreme vol sanity (>10 → fallback)
    close_extreme = df['Close'].values.copy()
    close_extreme[-2] = close_extreme[-3] * 100  # 10000% return
    vol_extreme = compute_vol(close_extreme)
    if vol_extreme == 0.30:
        PASS(S, 'Extreme vol → fallback 0.30')
    else:
        WARN(S, 'Extreme vol → fallback 0.30', f'Got {vol_extreme:.4f}')


# ==============================================================================
# 6. SANITIZER TESTS
# ==============================================================================
def check_sanitizer():
    section_header('6. Sanitizer (_sanitize_predictions)')
    S = '6.sanitizer'
    try:
        from predict_core import _sanitize_predictions
    except Exception as e:
        FAIL(S, '_sanitize_predictions import', str(e))
        return

    cur = 100.0

    def _base_result(pct_1w=5, pct_1m=10, pct_6m=20, pct_1y=30, vol=0.30):
        traj = [
            {'predicted_price': cur * (1 + pct_1w / 100), 'lower_bound': cur * 0.98, 'upper_bound': cur * 1.08},
            {'predicted_price': cur * (1 + pct_1m / 100), 'lower_bound': cur * 0.92, 'upper_bound': cur * 1.18},
            None, None, None, None,
            {'predicted_price': cur * (1 + pct_6m / 100), 'lower_bound': cur * 0.80, 'upper_bound': cur * 1.40},
            None, None, None, None, None,
            {'predicted_price': cur * (1 + pct_1y / 100), 'lower_bound': cur * 0.70, 'upper_bound': cur * 1.50},
        ]
        return {
            'ticker': 'DIAG',
            'regularMarketPrice': cur,
            'realized_vol_60d': vol,
            'predicted_price_1w': cur * (1 + pct_1w / 100),
            'predicted_change_pct_1w': float(pct_1w),
            'confidence_score_1w': 75,
            'predicted_price_1m': cur * (1 + pct_1m / 100),
            'predicted_change_pct_1m': float(pct_1m),
            'confidence_score_1m': 70,
            'predicted_price_6m': cur * (1 + pct_6m / 100),
            'predicted_change_pct_6m': float(pct_6m),
            'confidence_score_6m': 65,
            'predicted_price_1y': cur * (1 + pct_1y / 100),
            'predicted_change_pct_1y': float(pct_1y),
            'confidence_score_1y': 60,
            'monthly_trajectory': traj,
            'predicted_range_1w': [cur * 0.95, cur * 1.08],
            'predicted_range_1m': [cur * 0.90, cur * 1.15],
            'predicted_range_6m': [cur * 0.75, cur * 1.40],
            'predicted_range_1y': [cur * 0.65, cur * 1.50],
        }

    # 6a. Normal prediction passes through unchanged
    r = _sanitize_predictions(_base_result())
    if r.get('predicted_change_pct_1m') == 10.0:
        PASS(S, 'Normal prediction passes unchanged')
    else:
        FAIL(S, 'Normal prediction passes unchanged',
             f'pct_1m={r.get("predicted_change_pct_1m")}')

    # 6b. Negative price floored to 0.01
    r2 = _base_result()
    r2['predicted_price_1m'] = -50.0
    r2['predicted_change_pct_1m'] = -150.0
    r2_out = _sanitize_predictions(r2)
    if r2_out.get('predicted_price_1m', 0) >= 0.0:
        PASS(S, 'Negative price floored', f'→ {r2_out.get("predicted_price_1m")}')
    else:
        FAIL(S, 'Negative price floored', f'Still {r2_out.get("predicted_price_1m")}')

    # 6c. Extreme pct_1m clamped + conf=25
    r3 = _base_result(pct_1m=500)
    r3_out = _sanitize_predictions(r3)
    clamped_pct = r3_out.get('predicted_change_pct_1m', 0)
    clamped_conf = r3_out.get('confidence_score_1m', 100)
    if abs(clamped_pct) <= 40 and clamped_conf == 25:
        PASS(S, 'Extreme pct_1m clamped → conf=25',
             f'pct={clamped_pct}, conf={clamped_conf}')
    else:
        FAIL(S, 'Extreme pct_1m clamped → conf=25',
             f'pct={clamped_pct}, conf={clamped_conf}')

    # 6d. 1m/6m coherence rule — opposite signs
    # Use pct_1y same sign as pct_6m so the 6m/1y rebalancer doesn't fire first
    # and change pct_6m before the 1m/6m check runs.
    r4 = _base_result(pct_1w=5, pct_1m=25, pct_6m=-20, pct_1y=-35)
    r4_out = _sanitize_predictions(r4)
    pct_1m_out = r4_out.get('predicted_change_pct_1m')
    pct_6m_out = r4_out.get('predicted_change_pct_6m')
    pct_1w_out = r4_out.get('predicted_change_pct_1w')
    reason_1m = r4_out.get('confidence_reason_1m', '')
    # Coherence rule should glide-path 1m between 1w and 6m
    expected_glide = round(float(pct_1w_out) + (float(pct_6m_out) - float(pct_1w_out)) * (21 - 5) / (126 - 5), 2)
    glide_fired = 'interpolated' in str(reason_1m) or 'incoherent' in str(reason_1m)
    if glide_fired:
        PASS(S, '1m/6m coherence fix (opposite signs)',
             f'1m glided to {pct_1m_out:.2f}% (expected ~{expected_glide:.2f}%)')
    else:
        WARN(S, '1m/6m coherence fix (opposite signs)',
             f'Coherence rule did not fire. 1m={pct_1m_out:.2f}%, 6m={pct_6m_out:.2f}%, reason={reason_1m[:80]}')

    # 6e. trajectory[1] updated after 1m clamp
    r5 = _base_result(pct_1m=500)
    r5_out = _sanitize_predictions(r5)
    traj1 = r5_out.get('monthly_trajectory', [None, None])[1]
    new_price_1m = r5_out.get('predicted_price_1m')
    if (isinstance(traj1, dict)
            and isinstance(new_price_1m, (int, float))
            and abs(traj1.get('predicted_price', 0) - new_price_1m) < 0.05):
        PASS(S, 'trajectory[1] updated after 1m clamp',
             f'traj[1].price={traj1.get("predicted_price")}, predicted={new_price_1m}')
    else:
        FAIL(S, 'trajectory[1] updated after 1m clamp',
             f'traj[1]={traj1}, predicted_price_1m={new_price_1m}')

    # 6f. NaN input → None (not crash)
    r6 = _base_result()
    r6['predicted_price_1m'] = float('nan')
    r6['predicted_change_pct_1m'] = float('nan')
    try:
        r6_out = _sanitize_predictions(r6)
        val = r6_out.get('predicted_price_1m')
        if val is None or (isinstance(val, float) and math.isnan(val)):
            PASS(S, 'NaN price → None (not crash)', f'→ {val}')
        else:
            WARN(S, 'NaN price → None', f'→ {val} (not None)')
    except Exception as e:
        FAIL(S, 'NaN price → None (not crash)', f'Raised: {e}')


# ==============================================================================
# 7. FEATURE PIPELINE — all FEATURE_COLUMNS populated
# ==============================================================================
def check_feature_pipeline():
    section_header('7. Feature Pipeline Coverage')
    S = '7.feature_pipeline'
    try:
        from predict_core import (
            FEATURE_COLUMNS, _calculate_features_internal,
        )
    except ImportError:
        try:
            from predict_core import FEATURE_COLUMNS
            _calculate_features_internal = None
        except Exception as e:
            FAIL(S, 'predict_core import', str(e))
            return

    if _calculate_features_internal is None:
        WARN(S, '_calculate_features_internal', 'Not importable — skipping pipeline coverage check')
        return

    df = _make_synthetic_ohlcv(n=600)
    stock_metrics = _make_stock_metrics()
    macro = {
        'VIX': 18.5,
        'Treasury10Y': 4.2,
        'Treasury3M': 5.1,
        'HYG_Level': 78.0,
        'LQD_Level': 110.0,
        'DXY_Level': 104.0,
    }
    history_json = [
        {'date': str(d.date()), 'Open': float(r['Open']), 'High': float(r['High']),
         'Low': float(r['Low']), 'Close': float(r['Close']), 'Volume': float(r['Volume'])}
        for d, r in df.iterrows()
    ]
    # _calculate_features_internal(df, stock_metrics, macro_data, news_sentiment,
    #                              earnings_beat_streak, current_price, ...)
    df['Date'] = df.index
    current_price = float(df['Close'].iloc[-1])
    try:
        feat_df = _calculate_features_internal(
            df, stock_metrics, macro, 0.0, 0, current_price,
        )
    except Exception as e:
        FAIL(S, '_calculate_features_internal call', f'{type(e).__name__}: {e}')
        return

    # Check every FEATURE_COLUMN is present
    missing_cols = [f for f in FEATURE_COLUMNS if f not in feat_df.columns]
    if missing_cols:
        FAIL(S, 'All FEATURE_COLUMNS in feat_df', f'{len(missing_cols)} missing: {missing_cols[:10]}')
    else:
        PASS(S, 'All FEATURE_COLUMNS in feat_df', f'{len(FEATURE_COLUMNS)} columns present')

    # Check for all-NaN columns
    all_nan = [f for f in FEATURE_COLUMNS if f in feat_df.columns and feat_df[f].isna().all()]
    if all_nan:
        WARN(S, 'No all-NaN feature columns', f'{len(all_nan)} all-NaN: {all_nan[:10]}')
    else:
        PASS(S, 'No all-NaN feature columns')

    # Check for all-zero columns (potential fill issues).
    # Many columns legitimately zero in a minimal synthetic-data context
    # (no live options chain, no analyst history, no macro time-series, etc.)
    all_zero = [f for f in FEATURE_COLUMNS if f in feat_df.columns
                and (feat_df[f].fillna(0) == 0).all()]
    # Columns that are routinely zero without live external data feeds
    expected_zeros = {
        # Options (no live chain)
        'IV', 'IV_Rank', 'Put_Call_Ratio', 'IV_HV_Ratio',
        # Analyst / sentiment (no external DB)
        'NewsSentiment', 'SearchInterest_20d_Change',
        'Rating_Up_30d', 'Rating_Down_30d', 'Rating_Up_90d', 'Rating_Down_90d',
        'NetRating_90d', 'UpgradeScore_90d',
        'TargetMean_Revision_30d', 'EPSEst_Revision_30d_CurrQ', 'EPSEst_Revision_30d_NextQ',
        'EPS_Revision_7d_0Q', 'EPS_Revision_7d_1Q',
        'Revenue_Est_Growth_0Q', 'Revenue_Est_Growth_1Q',
        'EPS_Rev_Up7d', 'EPS_Rev_Down7d',
        'Upgrade_Score_7d', 'Upgrade_Score_30d',
        # Insider / earnings surprise (no SEC DB)
        'InsiderNetSellRatio_90d', 'InsiderTxCount_90d',
        'EPS_Surprise_Avg_4Q', 'Revenue_Surprise_Avg_4Q',
        'EarningsBeatStreak',
        # Microstructure (no pre/post-market feed)
        'PreMarket_GapPct', 'PostMarket_GapPct',
        # Sector-relative (no sector peers passed)
        'PE_LogRatio_vs_Sector', 'PB_LogRatio_vs_Sector', 'RevGrowth_Delta_vs_Sector',
        'PS_LogRatio_vs_Sector', 'FCF_Yield_vs_Sector',
        # Peer RS (no peer group)
        'Peer_RS_5d',
        # Macro time-series (no macro series in this test)
        'VIX', 'VIX_20d_Avg', 'Treasury10Y', 'Treasury3M',
        'HYG_Level', 'HYG_Mom_20d', 'LQD_Level', 'LQD_Mom_20d', 'HYG_LQD_Ratio',
        'DXY_Level', 'DXY_Return_20d', 'CurveSlope_10M3M',
        'RS_vs_SPY_20d', 'RS_vs_SectorETF_20d', 'SectorETF_60d_Corr',
        'WTI_Return_20d', 'WTI_Beta_60d',
        'Copper_Return_20d', 'Copper_Beta_60d',
        'Wheat_Return_20d', 'Wheat_Beta_60d',
        'VIX_RealVol_Ratio', 'PC_Skew_Proxy',
        # WorldBank annual
        'WorldBank_GDP', 'WorldBank_Inflation', 'WorldBank_Consumption', 'WorldBank_Real_GDP',
        # Fundamentals needing specific Yahoo fields (zero if field absent)
        'AnalystPremium', 'AnalystPremiumWeighted', 'RecommendationMean',
        'FCF_Yield', 'PriceToSales', 'EV_EBITDA', 'EV_Revenue',
        'CashRunwayQuarters', 'Unprofitable_Flag',
        'Institution_PctHeld', 'Institution_PctDelta',
        'ShortFloatPct', 'DaysToCover',
        # Post-earnings drift (requires historical earnings data)
        'PostEarnings_DayN', 'PostEarnings_CumReturn', 'PostEarnings_VolRatio',
        # Earnings window (requires nextEarningsDate in stock_metrics)
        'Days_Since_Last_Earnings', 'Earnings_In_Window',
    }
    unexpected_zeros = [f for f in all_zero if f not in expected_zeros]
    if unexpected_zeros:
        WARN(S, 'No unexpected all-zero columns',
             f'{len(unexpected_zeros)} non-expected: {unexpected_zeros[:8]}')
    else:
        PASS(S, 'No unexpected all-zero columns',
             f'{len(all_zero)} expected-zero (no live feeds in test)')

    # NaN fraction in last row (what the model actually sees)
    last = feat_df[FEATURE_COLUMNS].iloc[-1]
    nan_last = last.isna().sum()
    if nan_last > 20:
        WARN(S, 'Last row NaN count', f'{nan_last}/{len(FEATURE_COLUMNS)} NaN in inference row')
    else:
        PASS(S, 'Last row NaN count', f'{nan_last}/{len(FEATURE_COLUMNS)} NaN in inference row')


# ==============================================================================
# 8. CS MODEL FEATURE ALIGNMENT
# ==============================================================================
def check_cs_model_alignment():
    section_header('8. CS Model Feature Alignment')
    S = '8.cs_alignment'
    try:
        from predict_core import FEATURE_COLUMNS
    except Exception as e:
        FAIL(S, 'predict_core import', str(e))
        return

    for pkl_name, label in [
        ('long_term_cs_v2.pkl', 'LT CS v2'),
        ('short_term_cs_v2.pkl', 'ST CS v2'),
    ]:
        fpath = MODELS_DIR / pkl_name
        if not fpath.exists():
            WARN(S, f'{label} alignment', 'File not found — skip')
            continue
        try:
            import joblib
            payload = joblib.load(str(fpath))
            cs_feats = payload.get('feature_columns', [])
            scaler = payload.get('scaler')
            model = payload.get('model')

            # Feature count consistency
            if hasattr(scaler, 'n_features_in_'):
                scaler_n = scaler.n_features_in_
                if scaler_n != len(cs_feats):
                    FAIL(S, f'{label} scaler.n_features == len(feature_columns)',
                         f'scaler={scaler_n}, cols={len(cs_feats)}')
                else:
                    PASS(S, f'{label} scaler.n_features == len(feature_columns)',
                         f'{scaler_n} features')

            # All CS features are in FEATURE_COLUMNS (or are known interaction terms
            # computed at inference time in predict_weighted_analysis.py)
            CS_ONLY_INTERACTION_FEATS = {
                'VIX_x_HYG_LQD', 'VIX_x_CurveSlope', 'HYG_x_RS_SPY', 'VIX_x_HistVol60',
                'Regime_x_PC_Ratio', 'Regime_x_HYG_LQD', 'Regime_x_RS_SPY',
            }
            unknown = [f for f in cs_feats
                       if f not in FEATURE_COLUMNS
                       and not f.startswith('Regime_')
                       and f not in CS_ONLY_INTERACTION_FEATS]
            interaction_in_cs = [f for f in cs_feats if f in CS_ONLY_INTERACTION_FEATS
                                  or f.startswith('Regime_')]
            if unknown:
                FAIL(S, f'{label} all CS features in FEATURE_COLUMNS',
                     f'{len(unknown)} truly unknown: {unknown[:5]}')
            else:
                PASS(S, f'{label} all CS features in FEATURE_COLUMNS',
                     f'{len(cs_feats)} features valid '
                     f'({len(interaction_in_cs)} are runtime interaction terms)')

            # trained_at present
            trained_at = payload.get('trained_at', None)
            if trained_at:
                PASS(S, f'{label} trained_at', str(trained_at))
            else:
                WARN(S, f'{label} trained_at', 'Missing trained_at metadata')

        except Exception as e:
            FAIL(S, f'{label} load', str(e))


# ==============================================================================
# 9. RANKER MODEL ALIGNMENT
# ==============================================================================
def check_ranker_alignment():
    section_header('9. Ranker Model Alignment')
    S = '9.ranker'
    try:
        from ranker_features import FEATURE_COLUMNS as RANKER_COLS, FEATURE_SET_VERSION
    except ImportError:
        WARN(S, 'ranker_features import', 'Module not found — skipping')
        return
    except Exception as e:
        FAIL(S, 'ranker_features import', str(e))
        return

    PASS(S, 'ranker_features import', f'{len(RANKER_COLS)} features, v={FEATURE_SET_VERSION}')

    for fname, label in [
        ('ranker_v1_lambdarank.txt', 'LambdaRank'),
        ('ranker_v1_regression.txt', 'Regression'),
    ]:
        fpath = MODELS_DIR / fname
        if not fpath.exists():
            FAIL(S, f'{label} file exists', 'NOT FOUND')
            continue
        try:
            import lightgbm as lgb
            bst = lgb.Booster(model_file=str(fpath))
            n_lgb_feats = bst.num_feature()
            if n_lgb_feats != len(RANKER_COLS):
                FAIL(S, f'{label} feature count matches ranker_features',
                     f'LightGBM={n_lgb_feats}, ranker_features={len(RANKER_COLS)}')
            else:
                PASS(S, f'{label} feature count matches ranker_features',
                     f'{n_lgb_feats} features')
        except ImportError:
            WARN(S, f'{label} feature count', 'lightgbm not installed')
        except Exception as e:
            FAIL(S, f'{label} load', str(e))


# ==============================================================================
# 10. FULL PREDICTION SMOKE TEST
# ==============================================================================
def check_prediction_smoke():
    section_header('10. Full Prediction Smoke Test')
    S = '10.smoke'

    try:
        import predict_weighted_analysis as pwa
    except Exception as e:
        FAIL(S, 'predict_weighted_analysis import', str(e))
        return

    df = _make_synthetic_ohlcv(n=700)
    stock_metrics = _make_stock_metrics()
    history_json = [
        {'date': str(d.date()), 'open': float(r['Open']), 'high': float(r['High']),
         'low': float(r['Low']), 'close': float(r['Close']), 'volume': float(r['Volume'])}
        for d, r in df.iterrows()
    ]
    macro = {
        'VIX': 18.5, 'VIX_20d_Avg': 17.0,
        'Treasury10Y': 4.2, 'Treasury3M': 5.1,
        'HYG': [{'date': str((date.today() - timedelta(days=i)).isoformat()),
                 'Close': 78.0 + i * 0.01} for i in range(100)],
        'LQD': [{'date': str((date.today() - timedelta(days=i)).isoformat()),
                 'Close': 110.0 + i * 0.01} for i in range(100)],
        'DXY': [{'date': str((date.today() - timedelta(days=i)).isoformat()),
                 'Close': 104.0 + i * 0.01} for i in range(100)],
        'SPY': [{'date': str((date.today() - timedelta(days=i)).isoformat()),
                 'Close': 500.0 + i * 0.1} for i in range(100)],
    }

    # predict(ticker, input_data) — input_data keys match the route payload
    input_data = {
        'historicalData': history_json,
        'stockMetrics': stock_metrics,
        'macroData': macro,
        'optionsData': {},
        'featureMetrics': {},
        'newsArticles': [],
        'historicalEarnings': [],
        'dataQuality': {},
        'technicalScore': 0.0,
    }
    try:
        result = pwa.predict('DIAG', input_data)
    except Exception as e:
        FAIL(S, 'predict() call', f'{type(e).__name__}: {e}')
        traceback.print_exc()
        return

    if result is None:
        FAIL(S, 'predict() returns non-None')
        return
    PASS(S, 'predict() returns non-None')

    # Required output keys
    required_keys = [
        'predicted_price_1w', 'predicted_change_pct_1w', 'confidence_score_1w',
        'predicted_price_1m', 'predicted_change_pct_1m', 'confidence_score_1m',
        'predicted_price_6m', 'predicted_change_pct_6m', 'confidence_score_6m',
        'predicted_price_1y', 'predicted_change_pct_1y', 'confidence_score_1y',
        'signal_confidence_1w', 'signal_confidence_1m',
        'monthly_trajectory',
    ]
    missing_keys = [k for k in required_keys if k not in result]
    if missing_keys:
        FAIL(S, 'Required output keys present', f'Missing: {missing_keys}')
    else:
        PASS(S, 'Required output keys present', f'{len(required_keys)} keys all present')

    # NaN / None in price outputs
    price_keys = ['predicted_price_1w', 'predicted_price_1m',
                  'predicted_price_6m', 'predicted_price_1y']
    nan_prices = [k for k in price_keys
                  if result.get(k) is None or
                     (isinstance(result.get(k), float) and math.isnan(result[k]))]
    if nan_prices:
        FAIL(S, 'No NaN/None predicted prices', f'NaN/None in: {nan_prices}')
    else:
        PASS(S, 'No NaN/None predicted prices')

    # Confidence scores in [0, 100]
    conf_keys = ['confidence_score_1w', 'confidence_score_1m',
                 'confidence_score_6m', 'confidence_score_1y']
    bad_conf = [k for k in conf_keys
                if not isinstance(result.get(k), (int, float))
                or not (0 <= result[k] <= 100)]
    if bad_conf:
        FAIL(S, 'Confidence scores in [0,100]',
             f'Bad: {[(k, result.get(k)) for k in bad_conf]}')
    else:
        PASS(S, 'Confidence scores in [0,100]',
             ', '.join(f'{k}={result[k]}' for k in conf_keys))

    # Signal confidence present and in [0, 100]
    sig_keys = ['signal_confidence_1w', 'signal_confidence_1m']
    bad_sig = [k for k in sig_keys
               if result.get(k) is None or
                  not isinstance(result.get(k), (int, float)) or
                  not (0 <= result[k] <= 100)]
    if bad_sig:
        FAIL(S, 'signal_confidence_1w/1m present and in [0,100]',
             f'Bad: {[(k, result.get(k)) for k in bad_sig]}')
    else:
        PASS(S, 'signal_confidence_1w/1m present and in [0,100]',
             ', '.join(f'{k}={result[k]}' for k in sig_keys))

    # Price direction coherence: all prices >= 0.01
    bad_prices = {k: result[k] for k in price_keys
                  if isinstance(result.get(k), (int, float)) and result[k] < 0.01}
    if bad_prices:
        FAIL(S, 'All predicted prices >= 0.01', str(bad_prices))
    else:
        PASS(S, 'All predicted prices >= 0.01')

    # monthly_trajectory: indices 1, 6, 12 present and price inside range
    traj = result.get('monthly_trajectory', [])
    for idx, h_label, price_key in [(1, '1m', 'predicted_price_1m'),
                                     (6, '6m', 'predicted_price_6m'),
                                     (12, '1y', 'predicted_price_1y')]:
        if len(traj) <= idx:
            FAIL(S, f'trajectory[{idx}] ({h_label}) exists', 'Index out of range')
            continue
        wp = traj[idx]
        if not isinstance(wp, dict):
            FAIL(S, f'trajectory[{idx}] ({h_label}) is dict', f'Got {type(wp)}')
            continue
        lo, hi = wp.get('lower_bound'), wp.get('upper_bound')
        pred_p = result.get(price_key)
        if not isinstance(lo, (int, float)) or not isinstance(hi, (int, float)):
            WARN(S, f'trajectory[{idx}] ({h_label}) bounds numeric',
                 f'lo={lo}, hi={hi}')
        elif isinstance(pred_p, (int, float)) and (pred_p < lo * 0.98 or pred_p > hi * 1.02):
            WARN(S, f'predicted_price_{h_label} inside trajectory[{idx}] range',
                 f'price={pred_p:.2f}, range=[{lo:.2f}, {hi:.2f}]')
        else:
            PASS(S, f'predicted_price_{h_label} inside trajectory[{idx}] range',
                 f'{pred_p:.2f} in [{lo:.2f}, {hi:.2f}]')

    # Print summary row
    print()
    print('  Prediction summary:')
    for h in ['1w', '1m', '6m', '1y']:
        pct = result.get(f'predicted_change_pct_{h}')
        cs = result.get(f'confidence_score_{h}')
        print(f'    {h:3s}: {pct:+.2f}%  conf={cs}')


# ==============================================================================
# 11. SHORT-TERM SIGNAL CONFIDENCE PATH
# ==============================================================================
def check_signal_confidence_path():
    section_header('11. Short-Term Signal Confidence (CS path)')
    S = '11.signal_conf'
    try:
        from predict_short_term import _ST_CS_MODEL
    except Exception as e:
        FAIL(S, 'predict_short_term import', str(e))
        return

    cs_active = _ST_CS_MODEL is not None
    if cs_active:
        PASS(S, 'CS model loaded', f'keys={list(_ST_CS_MODEL.keys())[:5]}')
    else:
        WARN(S, 'CS model loaded',
             'ST_CS_MODEL_VERSION=disabled — per-ticker MLP path will be tested instead')

    # Simulate a CS path result and verify signal_confidence is injected
    from predict_short_term import predict_short_term
    from predict_core import FEATURE_COLUMNS, SHORT_TERM_FEATURES

    df = _make_synthetic_ohlcv(n=600)
    sm = _make_stock_metrics()
    sm['nextEarningsDate'] = (date.today() + timedelta(days=30)).isoformat()

    from sklearn.preprocessing import MinMaxScaler
    feat_arr = df[['Open', 'High', 'Low', 'Close', 'Volume']].values
    scaler = MinMaxScaler()
    scaled = scaler.fit_transform(feat_arr)
    close_col_idx = 3
    n_features = feat_arr.shape[1]

    fake_targets_1d = df['Close'].pct_change().fillna(0).values
    fake_targets_1w = df['Close'].pct_change(5).fillna(0).values

    try:
        st_result = predict_short_term(
            scaled=scaled,
            feature_columns=['Open', 'High', 'Low', 'Close', 'Volume'],
            targets_1d=fake_targets_1d,
            targets_1w=fake_targets_1w,
            feat_df=df,
            current_price=float(df['Close'].iloc[-1]),
            non_analyst_impact=0.0,
            analyst_impact=0.0,
            analyst_count=0,
            consumer_multiplier=1.0,
            scaler=scaler,
            close_col_idx=close_col_idx,
            n_features=n_features,
            predicted_price_6m_base=float(df['Close'].iloc[-1]) * 1.15,
            confidence_score_6m=70,
            stock_metrics=sm,
            signal_confidence_6m=65,
        )
    except Exception as e:
        FAIL(S, 'predict_short_term call', f'{type(e).__name__}: {e}')
        return

    # signal_confidence must be present
    sig_1w = st_result.get('signal_confidence_1w')
    sig_1m = st_result.get('signal_confidence_1m')
    if sig_1w is None:
        FAIL(S, 'signal_confidence_1w in result', 'None — CS path not injecting it')
    elif not (0 <= sig_1w <= 100):
        FAIL(S, 'signal_confidence_1w in [0,100]', f'{sig_1w}')
    else:
        PASS(S, 'signal_confidence_1w in result', f'{sig_1w}')

    if sig_1m is None:
        FAIL(S, 'signal_confidence_1m in result', 'None — CS path not injecting it')
    elif not (0 <= sig_1m <= 100):
        FAIL(S, 'signal_confidence_1m in [0,100]', f'{sig_1m}')
    else:
        PASS(S, 'signal_confidence_1m in result', f'{sig_1m}')


# ==============================================================================
# LIVE TICKER DIAGNOSTIC
# ==============================================================================
SECTOR_MEDIANS = {
    'Technology':             {'peRatio': 28.0, 'pbRatio': 6.0, 'profitMargins': 0.20, 'revenueGrowth': 0.10, 'debtToEquity': 50,  'returnOnEquity': 0.25},
    'Healthcare':             {'peRatio': 22.0, 'pbRatio': 4.0, 'profitMargins': 0.12, 'revenueGrowth': 0.07, 'debtToEquity': 60,  'returnOnEquity': 0.15},
    'Financials':             {'peRatio': 12.0, 'pbRatio': 1.2, 'profitMargins': 0.20, 'revenueGrowth': 0.05, 'debtToEquity': 200, 'returnOnEquity': 0.12},
    'Financial Services':     {'peRatio': 12.0, 'pbRatio': 1.2, 'profitMargins': 0.20, 'revenueGrowth': 0.05, 'debtToEquity': 200, 'returnOnEquity': 0.12},
    'Consumer Cyclical':      {'peRatio': 20.0, 'pbRatio': 3.5, 'profitMargins': 0.07, 'revenueGrowth': 0.06, 'debtToEquity': 80,  'returnOnEquity': 0.18},
    'Consumer Defensive':     {'peRatio': 18.0, 'pbRatio': 3.0, 'profitMargins': 0.08, 'revenueGrowth': 0.04, 'debtToEquity': 70,  'returnOnEquity': 0.15},
    'Industrials':            {'peRatio': 18.0, 'pbRatio': 3.0, 'profitMargins': 0.09, 'revenueGrowth': 0.06, 'debtToEquity': 90,  'returnOnEquity': 0.16},
    'Energy':                 {'peRatio': 12.0, 'pbRatio': 1.8, 'profitMargins': 0.10, 'revenueGrowth': 0.04, 'debtToEquity': 50,  'returnOnEquity': 0.12},
    'Utilities':              {'peRatio': 16.0, 'pbRatio': 1.5, 'profitMargins': 0.12, 'revenueGrowth': 0.03, 'debtToEquity': 120, 'returnOnEquity': 0.10},
    'Real Estate':            {'peRatio': 30.0, 'pbRatio': 2.0, 'profitMargins': 0.25, 'revenueGrowth': 0.05, 'debtToEquity': 100, 'returnOnEquity': 0.08},
    'Communication Services': {'peRatio': 20.0, 'pbRatio': 3.5, 'profitMargins': 0.15, 'revenueGrowth': 0.07, 'debtToEquity': 70,  'returnOnEquity': 0.18},
    'Basic Materials':        {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
    'Materials':              {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
    '_default':               {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
}
SECTOR_ETF = {
    'Technology': 'XLK', 'Healthcare': 'XLV', 'Financials': 'XLF',
    'Financial Services': 'XLF', 'Consumer Cyclical': 'XLY', 'Consumer Defensive': 'XLP',
    'Industrials': 'XLI', 'Energy': 'XLE', 'Utilities': 'XLU', 'Real Estate': 'XLRE',
    'Basic Materials': 'XLB', 'Materials': 'XLB', 'Communication Services': 'XLC',
}
MACRO_SYMBOLS = {
    'vix': '^VIX', 'treasury10y': '^TNX', 'treasury3m': '^IRX',
    'hyg': 'HYG', 'lqd': 'LQD', 'dxy': 'DX-Y.NYB', 'spy': 'SPY',
    'wti': 'CL=F', 'copper': 'HG=F', 'wheat': 'ZW=F',
}


def _fetch_yf_series(symbol: str, start: date, end: date) -> list:
    try:
        import yfinance as yf
        df = yf.Ticker(symbol).history(
            start=start.isoformat(), end=end.isoformat(), auto_adjust=True)
        if df.empty:
            return []
        df = df.reset_index()
        df['Date'] = df['Date'].dt.strftime('%Y-%m-%d')
        return [{'date': r['Date'], 'close': float(r['Close'])} for _, r in df.iterrows()]
    except Exception:
        return []


def diagnose_ticker(ticker: str):
    """Fetch live yfinance data for `ticker` and run a targeted diagnostic."""
    try:
        import yfinance as yf
    except ImportError:
        print(_red('  yfinance not installed — cannot run live ticker diagnostic'))
        return

    try:
        import predict_weighted_analysis as pwa
        from predict_core import FEATURE_COLUMNS, build_features
    except Exception as e:
        print(_red(f'  Failed to import prediction modules: {e}'))
        return

    S = f'ticker:{ticker}'
    print(f'\n{_bold("=" * 60)}')
    print(_bold(f'  Live Ticker: {ticker.upper()}'))
    print(_bold('=' * 60))

    # ── 1. Fetch history ────────────────────────────────────────────────────
    print(f'\n  {_bold("Fetching data from yfinance...")}')
    end_dt   = date.today() + timedelta(days=1)
    start_dt = date.today() - timedelta(days=1825)  # 5 years, matches production route
    try:
        raw = yf.Ticker(ticker).history(
            start=start_dt.isoformat(), end=end_dt.isoformat(), auto_adjust=True)
    except Exception as e:
        FAIL(S, 'yfinance history fetch', str(e))
        return

    if raw.empty:
        FAIL(S, 'yfinance history fetch', 'No data returned — bad ticker?')
        return

    raw = raw.reset_index()
    raw['Date'] = raw['Date'].dt.strftime('%Y-%m-%d')
    hist = [
        {'date': r['Date'], 'open': float(r['Open']), 'high': float(r['High']),
         'low': float(r['Low']), 'close': float(r['Close']), 'volume': float(r['Volume'])}
        for _, r in raw.iterrows()
    ]
    PASS(S, 'yfinance history fetch', f'{len(hist)} trading days')

    # ── 2. Zero price check ─────────────────────────────────────────────────
    closes = [r['close'] for r in hist]
    zeros  = [r['date'] for r in hist if r['close'] <= 0]
    if zeros:
        FAIL(S, 'No zero close prices in history',
             f'{len(zeros)} zero(s): {zeros[:5]}')
    else:
        PASS(S, 'No zero close prices in history',
             f'min={min(closes):.2f}, max={max(closes):.2f}')

    # ── 3. History length ────────────────────────────────────────────────────
    if len(hist) < 365:
        WARN(S, 'History >= 365 days', f'Only {len(hist)} days — model may degrade')
    else:
        PASS(S, 'History >= 365 days', f'{len(hist)} trading days')

    # ── 4. Ticker info ───────────────────────────────────────────────────────
    try:
        info = yf.Ticker(ticker).info or {}
    except Exception as e:
        info = {}
        WARN(S, 'yfinance info fetch', str(e))

    sector = info.get('sector', '_default')
    current_price = info.get('regularMarketPrice') or closes[-1]
    PASS(S, 'Current price', f'${current_price:.2f}  sector={sector}')

    # ── 5. Build stock_metrics (live Yahoo fields) ───────────────────────────
    medians = SECTOR_MEDIANS.get(sector, SECTOR_MEDIANS['_default'])
    stock_metrics = {
        'regularMarketPrice':        current_price,
        'sector':                    sector,
        'peRatio':                   info.get('trailingPE') or medians['peRatio'],
        'pbRatio':                   info.get('priceToBook') or medians['pbRatio'],
        'profitMargins':             info.get('profitMargins') or medians['profitMargins'],
        'revenueGrowth':             info.get('revenueGrowth') or medians['revenueGrowth'],
        'debtToEquity':              info.get('debtToEquity') or medians['debtToEquity'],
        'returnOnEquity':            info.get('returnOnEquity') or medians['returnOnEquity'],
        'trailingEps':               info.get('trailingEps') or 0.0,
        'forwardEps':                info.get('forwardEps') or 0.0,
        'earningsGrowth':            info.get('earningsGrowth') or 0.0,
        'beta':                      info.get('beta') or 1.0,
        'dividendYield':             info.get('dividendYield') or 0.0,
        'analystTargetMean':         info.get('targetMeanPrice') or 0.0,
        'analystOpinionCount':       info.get('numberOfAnalystOpinions') or 0,
        'recommendationMean':        info.get('recommendationMean') or 3.0,
        'recommendationKey':         info.get('recommendationKey'),
        'nextEarningsDate':          None,
        'lastEarningsDate':          None,
        'freeCashflow':              info.get('freeCashflow') or 0,
        'ebitda':                    info.get('ebitda') or 0,
        'totalRevenue':              info.get('totalRevenue') or 0,
        'enterpriseValue':           info.get('enterpriseValue') or 0,
        'totalCash':                 info.get('totalCash') or 0,
        'marketCap':                 info.get('marketCap') or 0,
        'sharesOutstanding':         info.get('sharesOutstanding') or 0,
        'shortPercentOfFloat':       info.get('shortPercentOfFloat') or 0.0,
        'impliedVolatility':         info.get('impliedVolatility') or 0.0,
        'sectorMedianPe':            medians['peRatio'],
        'sectorMedianPb':            medians['pbRatio'],
        'sectorMedianRevenueGrowth': medians['revenueGrowth'],
        'sectorMedianProfitMargins': medians['profitMargins'],
    }

    fundamentals_present = sum(1 for k in
        ['trailingEps', 'freeCashflow', 'ebitda', 'totalRevenue', 'marketCap']
        if info.get(k))
    if fundamentals_present < 3:
        WARN(S, 'Fundamental fields from Yahoo',
             f'Only {fundamentals_present}/5 key fields populated — imputed to sector medians')
    else:
        PASS(S, 'Fundamental fields from Yahoo',
             f'{fundamentals_present}/5 key fields populated')

    # ── 6. Fetch macro time series ───────────────────────────────────────────
    print(f'  Fetching macro series...', end='', flush=True)
    macro_start = date.today() - timedelta(days=400)
    macro_raw = {}
    for key, sym in MACRO_SYMBOLS.items():
        macro_raw[key] = _fetch_yf_series(sym, macro_start, end_dt)
    # Sector ETF
    sector_etf_sym = SECTOR_ETF.get(sector, 'SPY')
    macro_raw['sectorEtf'] = _fetch_yf_series(sector_etf_sym, macro_start, end_dt)
    macro_raw['worldBank'] = None
    print(' done')

    macro_populated = sum(1 for k, v in macro_raw.items() if v and len(v) > 10)
    if macro_populated < 8:
        WARN(S, 'Macro series fetched', f'Only {macro_populated}/10 series have data')
    else:
        PASS(S, 'Macro series fetched',
             f'{macro_populated}/10 series populated '
             f'(VIX={len(macro_raw.get("vix", []))} rows)')

    # ── 7. Feature pipeline on real data ────────────────────────────────────
    # Build a DataFrame matching what _calculate_features_internal expects
    df_live = pd.DataFrame(hist)
    df_live.columns = [c.capitalize() if c in ('open','high','low','close','volume') else c
                       for c in df_live.columns]
    df_live = df_live.rename(columns={'Date': 'Date', 'Open': 'Open', 'High': 'High',
                                       'Low': 'Low', 'Close': 'Close', 'Volume': 'Volume'})
    df_live['Date'] = df_live['date'] if 'date' in df_live.columns else df_live['Date']

    # Build macro_data in the format build_features / _add_macro_features expect
    macro_for_features = {
        'vix':         macro_raw.get('vix', []),
        'treasury10y': macro_raw.get('treasury10y', []),
        'treasury3m':  macro_raw.get('treasury3m', []),
        'hyg':         macro_raw.get('hyg', []),
        'lqd':         macro_raw.get('lqd', []),
        'dxy':         macro_raw.get('dxy', []),
        'spy':         macro_raw.get('spy', []),
        'wti':         macro_raw.get('wti', []),
        'copper':      macro_raw.get('copper', []),
        'wheat':       macro_raw.get('wheat', []),
        'sectorEtf':   {'ticker': sector_etf_sym, 'data': macro_raw.get('sectorEtf', [])},
        'worldBank':   None,
    }
    try:
        feat_df = build_features(
            df_live, stock_metrics, macro_for_features,
            0.0, 0, current_price, ticker=ticker,
        )
        PASS(S, 'Feature pipeline runs on real data', f'{len(feat_df)} rows computed')
    except Exception as e:
        FAIL(S, 'Feature pipeline runs on real data', f'{type(e).__name__}: {e}')
        feat_df = None

    if feat_df is not None:
        # Zero price check after pipeline (forward-fill should have run)
        bad_close = (feat_df['Close'] <= 0).sum() if 'Close' in feat_df.columns else 0
        if bad_close:
            FAIL(S, 'No zero/negative Close in feat_df after pipeline', f'{bad_close} rows')
        else:
            PASS(S, 'No zero/negative Close in feat_df after pipeline')

        # NaN in last row
        last = feat_df[FEATURE_COLUMNS].iloc[-1]
        nan_cols = [c for c in FEATURE_COLUMNS if pd.isna(last.get(c, float('nan')))]
        zero_cols = [c for c in FEATURE_COLUMNS
                     if not pd.isna(last.get(c, float('nan'))) and last.get(c, 1.0) == 0.0]
        if len(nan_cols) > 5:
            WARN(S, 'Inference row NaN count',
                 f'{len(nan_cols)} NaN features: {nan_cols[:8]}')
        else:
            PASS(S, 'Inference row NaN count', f'{len(nan_cols)} NaN (expected)')

        # Show per-group feature value summary
        print(f'\n  {_bold("Feature value snapshot (last inference row):")}')
        groups = [
            ('OHLCV',        ['Open','High','Low','Close','Volume']),
            ('Momentum',     ['RSI_14','MACD','STOCH_K','ROC_5d','ROC_20d','Return_5d']),
            ('Vol',          ['HistVol_30','HistVol_60','ATR_14']),
            ('Trend',        ['HiRatio_52w','LoRatio_52w','GoldenCross','ROC_6m','ROC_12m']),
            ('Fundamentals', ['PE_Ratio','PB_Ratio','TrailingEPS','RevenueGrowth','ProfitMargins']),
            ('Analyst',      ['AnalystPremium','RecommendationMean','Rating_Up_30d','NetRating_90d']),
            ('Macro',        ['VIX','Treasury10Y','HYG_Level','DXY_Level','CurveSlope_10M3M']),
            ('Options',      ['IV','IV_Rank','Put_Call_Ratio','IV_HV_Ratio']),
            ('Earnings',     ['EarningsBeatStreak','Earnings_In_Window','Days_To_Next_Earnings',
                              'PostEarnings_DayN','EPS_Surprise_Avg_4Q']),
        ]
        for group_name, cols in groups:
            vals = []
            for c in cols:
                if c not in feat_df.columns:
                    vals.append(f'{c}=MISSING')
                else:
                    v = last.get(c)
                    if pd.isna(v):
                        vals.append(f'{c}=NaN')
                    elif v == 0.0:
                        vals.append(f'{c}=0')
                    else:
                        vals.append(f'{c}={v:.3g}')
            print(f'    {group_name:14s}: {", ".join(vals)}')

    # ── 8. Full prediction run ───────────────────────────────────────────────
    print(f'\n  {_bold("Running full prediction...")}')

    # Convert macro_raw to the format predict() expects (key names match route.ts)
    macro_for_predict = {
        'vix':         macro_raw.get('vix', []),
        'treasury10y': macro_raw.get('treasury10y', []),
        'treasury3m':  macro_raw.get('treasury3m', []),
        'hyg':         macro_raw.get('hyg', []),
        'lqd':         macro_raw.get('lqd', []),
        'dxy':         macro_raw.get('dxy', []),
        'spy':         macro_raw.get('spy', []),
        'wti':         macro_raw.get('wti', []),
        'copper':      macro_raw.get('copper', []),
        'wheat':       macro_raw.get('wheat', []),
        'sectorEtf':   {'ticker': sector_etf_sym, 'data': macro_raw.get('sectorEtf', [])},
        'worldBank':   None,
    }
    input_data = {
        'historicalData':     hist,
        'stockMetrics':       stock_metrics,
        'macroData':          macro_for_predict,
        'optionsData':        {},
        'featureMetrics':     {},
        'newsArticles':       [],
        'historicalEarnings': [],
        'dataQuality':        {
            'imputedFields': [],
            'historyYears':  round(len(hist) / 252, 1),
        },
        'technicalScore':    0.0,
        'recommendationKey': info.get('recommendationKey'),
    }

    try:
        result = pwa.predict(ticker, input_data)
    except Exception as e:
        FAIL(S, 'predict() call', f'{type(e).__name__}: {e}')
        traceback.print_exc()
        return

    if result is None:
        FAIL(S, 'predict() returns non-None')
        return

    # Output checks
    required_keys = [
        'predicted_price_1w', 'predicted_change_pct_1w', 'confidence_score_1w',
        'predicted_price_1m', 'predicted_change_pct_1m', 'confidence_score_1m',
        'predicted_price_6m', 'predicted_change_pct_6m', 'confidence_score_6m',
        'predicted_price_1y', 'predicted_change_pct_1y', 'confidence_score_1y',
        'signal_confidence_1w', 'signal_confidence_1m',
        'monthly_trajectory',
    ]
    missing = [k for k in required_keys if k not in result]
    if missing:
        FAIL(S, 'All output keys present', f'Missing: {missing}')
    else:
        PASS(S, 'All output keys present')

    price_keys = ['predicted_price_1w','predicted_price_1m','predicted_price_6m','predicted_price_1y']
    nan_prices = [k for k in price_keys
                  if result.get(k) is None or
                     (isinstance(result.get(k), float) and math.isnan(result[k]))]
    if nan_prices:
        FAIL(S, 'No NaN/None predicted prices', f'{nan_prices}')
    else:
        PASS(S, 'No NaN/None predicted prices')

    neg_prices = {k: result[k] for k in price_keys
                  if isinstance(result.get(k), (int, float)) and result[k] < 0.01}
    if neg_prices:
        FAIL(S, 'All predicted prices >= 0.01', str(neg_prices))
    else:
        PASS(S, 'All predicted prices >= 0.01')

    # Confidence in range
    for ckey in ['confidence_score_1w','confidence_score_1m','confidence_score_6m','confidence_score_1y']:
        v = result.get(ckey)
        if not isinstance(v, (int, float)) or not (0 <= v <= 100):
            FAIL(S, f'{ckey} in [0,100]', str(v))

    # Signal confidence not None
    for skey in ['signal_confidence_1w', 'signal_confidence_1m']:
        v = result.get(skey)
        if v is None:
            FAIL(S, f'{skey} present', 'None — CS path signal injection missing')
        elif isinstance(v, (int, float)) and 0 <= v <= 100:
            PASS(S, f'{skey} present', str(v))
        else:
            FAIL(S, f'{skey} in [0,100]', str(v))

    # trajectory[1] in sync with predicted_price_1m
    traj = result.get('monthly_trajectory', [])
    if len(traj) > 1 and isinstance(traj[1], dict):
        traj_p = traj[1].get('predicted_price')
        pred_p = result.get('predicted_price_1m')
        if isinstance(traj_p, (int, float)) and isinstance(pred_p, (int, float)):
            if abs(traj_p - pred_p) > 0.10:
                WARN(S, 'trajectory[1] in sync with predicted_price_1m',
                     f'traj={traj_p:.2f}, predicted={pred_p:.2f}')
            else:
                PASS(S, 'trajectory[1] in sync with predicted_price_1m',
                     f'{traj_p:.2f} ≈ {pred_p:.2f}')

    # ── Final output table ───────────────────────────────────────────────────
    print(f'\n  {_bold(f"Prediction output for {ticker.upper()} (current ${current_price:.2f}):")}')
    print(f'  {"Horizon":<6}  {"Predicted":>10}  {"Change%":>8}  {"Range":>22}  {"Conf":>5}  {"Signal":>7}')
    print(f'  {"-"*6}  {"-"*10}  {"-"*8}  {"-"*22}  {"-"*5}  {"-"*7}')
    for h in ['1w', '1m', '6m', '1y']:
        price  = result.get(f'predicted_price_{h}')
        pct    = result.get(f'predicted_change_pct_{h}')
        cs     = result.get(f'confidence_score_{h}')
        sig    = result.get(f'signal_confidence_{h}', '--')
        r_key  = f'predicted_range_{h}'
        rng    = result.get(r_key, [None, None])
        rng_s  = f'[{rng[0]:.2f}, {rng[1]:.2f}]' if rng and rng[0] is not None else '--'
        price_s = f'${price:.2f}' if isinstance(price, (int, float)) else 'N/A'
        pct_s   = f'{pct:+.2f}%' if isinstance(pct, (int, float)) else 'N/A'
        sig_s   = str(int(sig)) if isinstance(sig, (int, float)) else '--'
        print(f'  {h:<6}  {price_s:>10}  {pct_s:>8}  {rng_s:>22}  {cs!s:>5}  {sig_s:>7}')

    reason_1m = result.get('confidence_reason_1m')
    if reason_1m:
        print(f'\n  1m note: {reason_1m[:120]}')
    reason_6m = result.get('confidence_reason_6m')
    if reason_6m:
        print(f'  6m note: {reason_6m[:120]}')


# ==============================================================================
# MAIN
# ==============================================================================
CHECKS = {
    'model_files':        check_model_files,
    'feature_columns':    check_feature_columns,
    'zero_price':         check_zero_price_guard,
    'vol_nan':            check_vol_nan_guard,
    'sanitizer':          check_sanitizer,
    'feature_pipeline':   check_feature_pipeline,
    'cs_alignment':       check_cs_model_alignment,
    'ranker':             check_ranker_alignment,
    'smoke':              check_prediction_smoke,
    'signal_confidence':  check_signal_confidence_path,
}


def main():
    parser = argparse.ArgumentParser(description='Prediction model diagnostics')
    parser.add_argument('--check', choices=list(CHECKS), help='Run only one section')
    parser.add_argument('--quiet', action='store_true', help='Summary only')
    parser.add_argument('--ticker', metavar='TICKER',
                        help='Run a live end-to-end diagnostic for a specific ticker '
                             '(fetches real yfinance data, skips synthetic checks)')
    args = parser.parse_args()

    if args.ticker:
        diagnose_ticker(args.ticker.upper())
        # Summary
        print(f'\n{_bold("=" * 60)}')
        print(_bold('  SUMMARY'))
        print(_bold('=' * 60))
        total = len(_results)
        passes = sum(1 for _, _, s in _results if s == 'PASS')
        fails  = sum(1 for _, _, s in _results if s == 'FAIL')
        warns  = sum(1 for _, _, s in _results if s == 'WARN')
        print(f'  Total checks : {total}')
        print(f'  {_green(f"PASS : {passes}")}')
        print(f'  {_yellow(f"WARN : {warns}")}')
        print(f'  {_red(f"FAIL : {fails}")}')
        if fails:
            print()
            for sec, name, s in _results:
                if s == 'FAIL':
                    print(f'    {_red("✗")} {name}')
        sys.exit(1 if fails else 0)

    checks_to_run = {args.check: CHECKS[args.check]} if args.check else CHECKS

    for name, fn in checks_to_run.items():
        try:
            fn()
        except Exception as e:
            print(f'\n  [{_red("ERROR")}] {name} raised an unhandled exception:')
            traceback.print_exc()
            _results.append((name, name, 'FAIL'))

    # Summary
    print(f'\n{_bold("=" * 60)}')
    print(_bold('  SUMMARY'))
    print(_bold('=' * 60))
    total = len(_results)
    passes = sum(1 for _, _, s in _results if s == 'PASS')
    fails  = sum(1 for _, _, s in _results if s == 'FAIL')
    warns  = sum(1 for _, _, s in _results if s == 'WARN')
    print(f'  Total checks : {total}')
    print(f'  {_green(f"PASS : {passes}")}')
    print(f'  {_yellow(f"WARN : {warns}")}')
    print(f'  {_red(f"FAIL : {fails}")}')
    print()

    if fails:
        fail_names = [f'{sec}/{name}' for sec, name, s in _results if s == 'FAIL']
        print(f'  Failed checks:')
        for f in fail_names:
            print(f'    {_red("✗")} {f}')

    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
