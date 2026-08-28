"""
predict_weighted_analysis.py — MLP-based stock price prediction (v3).

Improvements over v2:
  1. Lag features      — Close_lag_5/10/20, Volume_lag_5: explicit past-price
                         inputs so the MLP can learn temporal relationships.
  2. Short-term ROC    — ROC_5d, ROC_20d, Return_1d/5d/20d: short-window
                         momentum signals the MLP would otherwise miss.
  3. Trend context     — PriceToHigh/Low_20d, EMA slopes, VolumePriceTrend:
                         breakout/breakdown awareness and trend strength.
  4. Rolling stats     — RollingMean/Std/Skew/Sharpe_20d: compressed recent
                         return history for richer momentum context.
  MLP hidden layers widened (128→64→32) to handle the expanded feature set.
  MC noise now scales per-feature to recent volatility for better intervals.

CONSTRAINT: This script must NOT import yfinance, requests, urllib, httpx,
or any HTTP/network library. All data arrives via --input_file JSON.

CLI:
    python3 predict_weighted_analysis.py <ticker> --input_file <path>

Input (from file):
    JSON payload as produced by GET /api/stock_data/[ticker]/data

Output (stdout):
    JSON prediction result (see OUTPUT SCHEMA at bottom of file)
"""

import sys
import json
import argparse
import warnings
import random
import math
import hashlib
import os
import pickle

# ── CPU Throttling (Middle Ground) ──
# Limit math libraries to 1 thread to prevent saturating all cores.
# This must be done BEFORE importing numpy or sklearn.
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['VECLIB_MAXIMUM_THREADS'] = '1'
os.environ['NUMEXPR_NUM_THREADS'] = '1'

# Lower process priority so the OS favors other tasks (web server, etc.)
try:
    os.nice(15) 
except:
    pass

from datetime import datetime, timedelta, date

import numpy as np
import pandas as pd
from sklearn.preprocessing import MinMaxScaler
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.neural_network import MLPRegressor

warnings.filterwarnings('ignore')

# Reproducibility
SEED = 42
random.seed(SEED)
np.random.seed(SEED)

SEQ_LEN    = 45    # 45 trading-day lookback window (compromise for speed/accuracy)
N_EPOCHS   = 50    # capped for speed
BATCH_SIZE = 128   # larger batches for faster training
MC_RUNS    = 30    # reduced for faster trajectory generation
CACHE_DIR  = os.path.join(os.path.dirname(__file__), 'prediction_cache')

# Dirichlet (Laplace) smoothing applied to regime probabilities. Mirrors the
# constant in predict_core.py; baseline has its own copy of
# build_regime_detector so it needs the constant in scope. See predict_core.py
# for the full rationale.
REGIME_PROB_SMOOTHING_ALPHA = 0.05
CACHE_SCHEMA_VERSION = 7  # cleaned up the analyst-consensus block — removed temporary debug log + tracker variables now that the recommendationsHistory tertiary fallback is verified working for thinly-covered names like LPG.


# ============================================================================
# CACHING HELPERS
# ============================================================================
def get_cache_key(ticker, historical_data):
    """Generate a unique MD5 hash for (ticker, last_date, data_len, schema_version)."""
    if not historical_data:
        return None
    last_row = historical_data[-1]
    last_date = last_row.get('date', last_row.get('Date', ''))
    data_len = len(historical_data)
    key_str = f"{ticker}_{last_date}_{data_len}_v{CACHE_SCHEMA_VERSION}"
    return hashlib.md5(key_str.encode()).hexdigest()


def load_from_cache(key):
    if not key: return None
    cache_path = os.path.join(CACHE_DIR, f"{key}.json")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r') as f:
                return json.load(f)
        except:
            return None
    return None


def save_to_cache(key, result):
    if not key: return
    if not os.path.exists(CACHE_DIR):
        os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, f"{key}.json")
    try:
        with open(cache_path, 'w') as f:
            json.dump(result, f, cls=NumpyEncoder)
    except:
        pass


# ============================================================================
# CUSTOM JSON ENCODER
# ============================================================================
class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (np.integer,)):   return int(obj)
        if isinstance(obj, (np.floating,)):  return float(obj)
        if isinstance(obj, np.ndarray):      return obj.tolist()
        if isinstance(obj, np.bool_):        return bool(obj)
        return super().default(obj)


# ============================================================================
# HELPERS
# ============================================================================
def safe(val, default=0.0):
    """Return float(val) if valid, else default."""
    if val is None: return default
    try:
        f = float(val)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return default


def calculate_earnings_beat_streak(historical_earnings):
    streak = 0
    for e in (historical_earnings or []):
        actual   = e.get('epsActual')
        estimate = e.get('epsEstimate')
        if actual is not None and estimate is not None and actual > estimate:
            streak += 1
        else:
            break
    return streak


def calculate_news_sentiment(news_articles):
    if not news_articles:
        return 0.0
    
    # Financial lexicon for Python sentiment calculation
    financial_lexicon = {
        'beat': 3, 'beats': 3, 'surge': 3, 'growth': 2, 'backlog': 1,
        'demand': 1, 'bullish': 3, 'bearish': -3, 'upgrade': 3, 'downgrade': -3,
        'high-growth': 3, 'acceleration': 2, 'aligning': 1, 'drops': -2,
        'tumbles': -3, 'soars': 3, 'rally': 3, 'plunges': -3, 'lower': -1,
        'higher': 1, 'outperform': 3, 'underperform': -3, 'buy': 2, 'sell': -2,
        'profit': 2, 'loss': -2, 'miss': -3, 'misses': -3
    }
    
    score = 0
    count = 0
    for a in news_articles:
        title = (a.get('title') or '').lower()
        description = (a.get('description') or '').lower()
        combined_text = f"{title} {description}"
        
        # Simple word-based sentiment calculation to match the JS extras logic
        article_score = 0
        words = combined_text.split()
        for word in words:
            # Clean word (remove punctuation)
            clean_word = "".join(c for c in word if c.isalnum() or c == '-')
            if clean_word in financial_lexicon:
                article_score += financial_lexicon[clean_word]
        
        # Also include the original sentiment_score if it exists (from the JS Sentiment library)
        original_s = a.get('sentiment_score')
        if original_s is not None:
            article_score += original_s
            
        published_at = a.get('publishedAt')
        weight = 1.0
        if published_at:
            try:
                pub = datetime.fromisoformat(published_at.replace('Z', '+00:00'))
                age_days = (datetime.now(pub.tzinfo) - pub).days
                weight = max(0.1, 1.0 - age_days / 30.0)  # decay over 30 days
            except Exception:
                pass
        
        if article_score != 0:
            score += (1 if article_score > 0 else -1) * weight
            count += weight
            
    if count == 0:
        return 0.0
    return float(np.tanh(score / count))


def merge_series_by_date(base_dates, series):
    """
    Given a list of date strings and a list of {date, close} dicts,
    return a numpy array aligned to base_dates (forward-fill missing).
    """
    if not series:
        return np.zeros(len(base_dates))
    s = {row['date']: row['close'] for row in series}
    result = []
    last = 0.0
    for d in base_dates:
        v = s.get(d, None)
        if v is not None:
            last = float(v)
        result.append(last)
    return np.array(result, dtype=float)


# ============================================================================
# FEATURE ENGINEERING
# ============================================================================
FEATURE_COLUMNS = [
    # OHLCV
    'Open', 'High', 'Low', 'Close', 'Volume',
    # MACD
    'MACD', 'MACD_Signal',
    # Bollinger
    'BB_Upper', 'BB_Lower', 'BB_Mid',
    # RSI
    'RSI_14',
    # Stochastic
    'STOCH_K', 'STOCH_D',
    # ATR
    'ATR_14',
    # Moving averages
    'SMA_20', 'EMA_50', 'SMA_200', 'EMA_200',
    # Long-horizon indicators
    'HiRatio_52w', 'LoRatio_52w',
    'ROC_6m', 'ROC_12m',
    'GoldenCross',
    # Volatility
    'HistVol_30',
    # Fundamentals (scalar, broadcast across rows)
    'PE_Ratio', 'PB_Ratio', 'TrailingEPS', 'ForwardEPS',
    'RevenueGrowth', 'EarningsGrowth', 'ProfitMargins',
    'DebtToEquity', 'ReturnOnEquity', 'Beta', 'DivYield',
    'AnalystPremium', 'AnalystPremiumWeighted', 'RecommendationMean',
    # Macro (merged by date)
    'VIX', 'VIX_20d_Avg', 'Treasury10Y', 'SectorETF_60d_Corr',
    # Derived
    'NewsSentiment', 'EarningsBeatStreak',
    # Calendar
    'Month_Sin', 'Month_Cos', 'EarningsSeason',
    # ── Improvement 1: Lag features ──────────────────────────────────────────
    'Close_lag_5', 'Close_lag_10', 'Close_lag_20',
    'Volume_lag_5',
    # ── Improvement 2: Short-term ROC ────────────────────────────────────────
    'ROC_5d', 'ROC_20d',
    'Return_1d', 'Return_5d', 'Return_20d',
    # ── Improvement 3: Price relative to rolling high/low ────────────────────
    'PriceToHigh_20d', 'PriceToLow_20d',
    'PriceToHigh_5d',
    'VolumePriceTrend',
    'EMA_Slope_10', 'EMA_Slope_20',
    # ── Improvement 4: Rolling return statistics ─────────────────────────────
    'RollingMean_20d', 'RollingStd_20d',
    'RollingSkew_20d', 'RollingSharpe_20d',
    # ── Options Market Data ──────────────────────────────────────────────────
    'IV', 'IV_Rank', 'Put_Call_Ratio',
    # ── Earnings Surprises & Short Interest ──────────────────────────────────
    'EPS_Surprise_Avg_4Q', 'Revenue_Surprise_Avg_4Q',
    'ShortFloatPct', 'DaysToCover',
    # ── Insider Activity (SEC Form 4) ─────────────────────────────────────────
    'InsiderNetSellRatio_90d',  # net shares sold / outstanding (90d); positive = net selling
    'InsiderTxCount_90d',       # number of insider transactions (90d)
    # ── Credit risk proxy (Phase 1) ──────────────────────────────────────────
    'HYG_Level', 'HYG_Mom_20d',
    'LQD_Level', 'LQD_Mom_20d',
    'HYG_LQD_Ratio',
    # ── Dollar ───────────────────────────────────────────────────────────────
    'DXY_Level', 'DXY_Return_20d',
    # ── Rates / curve ────────────────────────────────────────────────────────
    'Treasury3M', 'CurveSlope_10M3M',
    # ── Relative strength ─────────────────────────────────────────────────────
    'RS_vs_SPY_20d',
    'RS_vs_SectorETF_20d',
    # ── Commodities ──────────────────────────────────────────────────────────
    'WTI_Return_20d', 'WTI_Beta_60d',
    'Copper_Return_20d', 'Copper_Beta_60d',
    'Wheat_Return_20d', 'Wheat_Beta_60d',
    # ── Volatility term structure proxy ──────────────────────────────────────
    'VIX_RealVol_Ratio',
    # ── Put/Call skew proxy ──────────────────────────────────────────────────
    'PC_Skew_Proxy',
    # ── Earnings-window flags ────────────────────────────────────────────────
    'Earnings_In_Window',
    'Days_Since_Last_Earnings',
    'Days_To_Next_Earnings',
    # ── World Bank Macro (annual, broadcast) ──────────────────────────────────
    'WorldBank_GDP',
    'WorldBank_Inflation',
    'WorldBank_Consumption',
    'WorldBank_Real_GDP',
    # ── Post-earnings drift (Items 02) ───────────────────────────────────────
    'PostEarnings_DayN',
    'PostEarnings_CumReturn',
    'PostEarnings_VolRatio',
    # ── EPS revision velocity (Item 03) ──────────────────────────────────────
    'EPS_Revision_7d_0Q',
    'EPS_Revision_7d_1Q',
    'Revenue_Est_Growth_0Q',
    'Revenue_Est_Growth_1Q',
    'EPS_Rev_Up7d',
    'EPS_Rev_Down7d',
    # ── Analyst upgrade/downgrade recency (Item 04) ──────────────────────────
    'Upgrade_Score_7d',
    'Upgrade_Score_30d',
    # ── Pre/post-market microstructure (Item 05) ─────────────────────────────
    'PreMarket_GapPct',
    'PostMarket_GapPct',
    'FiftyTwoWeek_PosRatio',
    # ── Institution ownership delta (Item 06) ────────────────────────────────
    'Institution_PctHeld',
    'Institution_PctDelta',
    # ── Peer relative strength (Item 08) ─────────────────────────────────────
    'Peer_RS_5d',
]


def _add_macro_features(f, date_strs, macro_data, close_s, hist_vol, stock_metrics):
    """
    Add Phase 1 macro/relative-strength/earnings features to feature DataFrame f.
    Computes credit spreads, DXY, curve slope, commodity betas, relative strength,
    vol proxies, and earnings-window flags.
    """
    n = len(f)

    # ── Credit risk proxy ────────────────────────────────────────────────────
    hyg_series = merge_series_by_date(date_strs, macro_data.get('hyg', []))
    lqd_series = merge_series_by_date(date_strs, macro_data.get('lqd', []))

    f['HYG_Level'] = hyg_series
    f['HYG_Mom_20d'] = pd.Series(hyg_series).pct_change(20).values

    f['LQD_Level'] = lqd_series
    f['LQD_Mom_20d'] = pd.Series(lqd_series).pct_change(20).values

    # HYG/LQD ratio: high ratio = weaker credit conditions (risk-off signal)
    f['HYG_LQD_Ratio'] = (hyg_series / (lqd_series + 1e-9))

    # ── Dollar ───────────────────────────────────────────────────────────────
    dxy_series = merge_series_by_date(date_strs, macro_data.get('dxy', []))
    f['DXY_Level'] = dxy_series
    f['DXY_Return_20d'] = pd.Series(dxy_series).pct_change(20).values

    # ── Rates / curve ────────────────────────────────────────────────────────
    tnx_series = merge_series_by_date(date_strs, macro_data.get('treasury10y', []))
    irx_series = merge_series_by_date(date_strs, macro_data.get('treasury3m', []))
    f['Treasury3M'] = irx_series
    f['CurveSlope_10M3M'] = tnx_series - irx_series

    # ── Relative strength ─────────────────────────────────────────────────────
    spy_series = merge_series_by_date(date_strs, macro_data.get('spy', []))
    spy_ret = pd.Series(spy_series).pct_change().fillna(0)
    etf_data = macro_data.get('sectorEtf', {}).get('data', [])
    etf_series = merge_series_by_date(date_strs, etf_data)
    etf_ret = pd.Series(etf_series).pct_change().fillna(0)

    stock_ret = close_s.pct_change().fillna(0)

    # 20-day rolling (stock_return - benchmark_return)
    f['RS_vs_SPY_20d'] = (stock_ret - spy_ret).rolling(20).mean().values
    f['RS_vs_SectorETF_20d'] = (stock_ret - etf_ret).rolling(20).mean().values

    # ── Commodities ──────────────────────────────────────────────────────────
    wti_series = merge_series_by_date(date_strs, macro_data.get('wti', []))
    copper_series = merge_series_by_date(date_strs, macro_data.get('copper', []))
    wheat_series = merge_series_by_date(date_strs, macro_data.get('wheat', []))

    wti_ret = pd.Series(wti_series).pct_change().fillna(0)
    copper_ret = pd.Series(copper_series).pct_change().fillna(0)
    wheat_ret = pd.Series(wheat_series).pct_change().fillna(0)

    f['WTI_Return_20d'] = wti_ret.rolling(20).mean().values
    f['Copper_Return_20d'] = copper_ret.rolling(20).mean().values
    f['Wheat_Return_20d'] = wheat_ret.rolling(20).mean().values

    # Rolling beta: covariance(stock_ret, commodity_ret) / variance(commodity_ret)
    def rolling_beta(stock_r, commodity_r, window=60):
        s = pd.Series(stock_r)
        c = pd.Series(commodity_r)
        cov = s.rolling(window).cov(c)
        var = c.rolling(window).var()
        return (cov / (var + 1e-9)).values

    f['WTI_Beta_60d'] = rolling_beta(stock_ret.values, wti_ret.values, window=60)
    f['Copper_Beta_60d'] = rolling_beta(stock_ret.values, copper_ret.values, window=60)
    f['Wheat_Beta_60d'] = rolling_beta(stock_ret.values, wheat_ret.values, window=60)

    # ── Volatility term structure proxy ──────────────────────────────────────
    vix_series = merge_series_by_date(date_strs, macro_data.get('vix', []))
    f['VIX_RealVol_Ratio'] = (vix_series / (hist_vol + 1e-9))

    # ── Put/Call skew proxy ──────────────────────────────────────────────────
    # IV_Rank * Put_Call_Ratio: weights the P/C ratio by IV extremeness
    iv_rank = f.get('IV_Rank', pd.Series(np.zeros(n))).fillna(0)
    put_call = f.get('Put_Call_Ratio', pd.Series(np.ones(n))).fillna(1.0)
    f['PC_Skew_Proxy'] = iv_rank.values * put_call.values

    # ── Earnings-window flags (Item 01) ──────────────────────────────────────
    next_e_str  = stock_metrics.get('nextEarningsDate')
    last_e_str  = stock_metrics.get('lastEarningsDate')  # new field from route

    date_objs_arr = pd.to_datetime(pd.Series(date_strs).str[:10], errors='coerce')
    today = date.today()

    # Days to next earnings (vectorized)
    if next_e_str:
        try:
            next_e = datetime.fromisoformat(str(next_e_str)[:10]).date()
            days_to_next = (next_e - today).days
            # Broadcast: shift by position relative to last row
            last_idx = len(date_objs_arr) - 1
            row_offsets = np.arange(len(date_objs_arr)) - last_idx  # 0 for last row
            f['Days_To_Next_Earnings'] = (days_to_next - row_offsets).astype(float)
        except Exception:
            f['Days_To_Next_Earnings'] = np.nan
    else:
        f['Days_To_Next_Earnings'] = np.nan

    # Days since last earnings (vectorized)
    if last_e_str:
        try:
            last_e = datetime.fromisoformat(str(last_e_str)[:10]).date()
            days_since_last = (today - last_e).days
            last_idx = len(date_objs_arr) - 1
            row_offsets = np.arange(len(date_objs_arr)) - last_idx
            f['Days_Since_Last_Earnings'] = np.maximum(0, days_since_last + row_offsets).astype(float)
        except Exception:
            f['Days_Since_Last_Earnings'] = 0.0
    else:
        f['Days_Since_Last_Earnings'] = 0.0

    # Earnings_In_Window: ±7 days of last OR next earnings
    days_to  = f['Days_To_Next_Earnings'].values
    days_from = f['Days_Since_Last_Earnings'].values
    f['Earnings_In_Window'] = np.where(
        (np.abs(days_to) <= 7) | (days_from <= 7), 1.0, 0.0
    )


    # ── World Bank Macro (Phase 4) ───────────────────────────────────────────
    wb = macro_data.get('worldBank', {}) or {}
    indicators = wb.get('indicators', {}) or {}

    # Broadcast scalar annual values to all rows
    f['WorldBank_GDP'] = safe(indicators.get('gdpGrowth'), 2.0)
    f['WorldBank_Inflation'] = safe(indicators.get('inflation'), 2.5)
    f['WorldBank_Consumption'] = safe(indicators.get('consumptionGrowth'), 2.0)
    f['WorldBank_Real_GDP'] = f['WorldBank_GDP'] - f['WorldBank_Inflation']

    return f


def build_features(df, stock_metrics, macro_data, news_sentiment, earnings_beat_streak, current_price, ticker=None, options_data=None, feature_metrics=None, next_earnings_date=None):
    """
    Build full feature DataFrame from OHLCV df + supplementary inputs.
    Implements a delta-calculation strategy: if a cached feature set exists
    for this ticker and the new data is an extension, we reuse old rows
    and only calculate the new ones (using a 252-row lookback for consistency).
    """
    n_total = len(df)
    dates = df['Date'].values if 'Date' in df.columns else np.arange(n_total)
    
    # ── Feature Caching Logic ────────────────────────────────────────────────
    feat_cache_path = os.path.join(CACHE_DIR, f"{ticker}_features_df.pkl") if ticker else None
    cached_df = None
    if feat_cache_path and os.path.exists(feat_cache_path):
        try:
            with open(feat_cache_path, 'rb') as f:
                cached_df = pickle.load(f)
        except:
            pass

    # Check if we can do an incremental update
    do_incremental = False
    if cached_df is not None and len(cached_df) < n_total:
        cached_dates = cached_df.index.values
        if np.array_equal(cached_dates, dates[:len(cached_df)]):
            do_incremental = True

    if do_incremental:
        n_new = n_total - len(cached_df)
        buffer = 252
        start_idx = max(0, len(cached_df) - buffer)
        sub_df = df.iloc[start_idx:].copy()
        
        f_tail = _calculate_features_internal(sub_df, stock_metrics, macro_data, news_sentiment, earnings_beat_streak, current_price, options_data, feature_metrics)
        f_new = f_tail.iloc[-(n_new):]
        f = pd.concat([cached_df, f_new])
        
        # Update broadcasted scalars which might change every run
        # (This is fast O(N) column assignment)
        cp = current_price if current_price and current_price > 0 else (df['Close'].iloc[-1] if len(df) > 0 else 1)
        atm = safe(stock_metrics.get('analystTargetMean'), 0.0)
        aoc = safe(stock_metrics.get('analystOpinionCount'), 0)
        rcm = safe(stock_metrics.get('recommendationMean'), 3.0)
        analyst_premium = (atm - cp) / (cp + 1e-9) if atm > 0 and cp > 0 else 0.0
        reliability = min(aoc / 40.0, 1.0)
        analyst_weighted = analyst_premium * reliability

        f['PE_Ratio'] = safe(stock_metrics.get('peRatio'), 20.0)
        f['PB_Ratio'] = safe(stock_metrics.get('pbRatio'), 3.0)
        f['TrailingEPS'] = safe(stock_metrics.get('trailingEps'), 0.0)
        f['ForwardEPS'] = safe(stock_metrics.get('forwardEps'), 0.0)
        f['RevenueGrowth'] = safe(stock_metrics.get('revenueGrowth'), 0.0)
        f['EarningsGrowth'] = safe(stock_metrics.get('earningsGrowth'), 0.0)
        f['ProfitMargins'] = safe(stock_metrics.get('profitMargins'), 0.0)
        f['DebtToEquity'] = safe(stock_metrics.get('debtToEquity'), 75.0)
        f['ReturnOnEquity'] = safe(stock_metrics.get('returnOnEquity'), 0.0)
        f['Beta'] = safe(stock_metrics.get('beta'), 1.0)
        f['DivYield'] = safe(stock_metrics.get('dividendYield'), 0.0)
        f['AnalystPremium'] = analyst_premium
        f['AnalystPremiumWeighted'] = analyst_weighted
        f['RecommendationMean'] = rcm
        f['NewsSentiment'] = news_sentiment
        f['EarningsBeatStreak'] = earnings_beat_streak
        
        wb = macro_data.get('worldBank', {}) or {}
        indicators = wb.get('indicators', {}) or {}
        f['WorldBank_GDP'] = safe(indicators.get('gdpGrowth'), 2.0)
        f['WorldBank_Inflation'] = safe(indicators.get('inflation'), 2.5)
        f['WorldBank_Consumption'] = safe(indicators.get('consumptionGrowth'), 2.0)
        f['WorldBank_Real_GDP'] = f['WorldBank_GDP'] - f['WorldBank_Inflation']

        if feature_metrics:
            f['InsiderNetSellRatio_90d'] = 0.0  # neutral for all historical rows
            f.iloc[-63:, f.columns.get_loc('InsiderNetSellRatio_90d')] = \
                max(-1.0, min(1.0, safe(feature_metrics.get('insiderNetSellRatio90d'), 0.0)))
            # Same for InsiderTxCount:
            f['InsiderTxCount_90d'] = 0.0
            f.iloc[-63:, f.columns.get_loc('InsiderTxCount_90d')] = \
                max(0.0, safe(feature_metrics.get('insiderTxCount90d'), 0.0))
    else:
        f = _calculate_features_internal(df, stock_metrics, macro_data, news_sentiment, earnings_beat_streak, current_price, options_data, feature_metrics)

    if feat_cache_path:
        try:
            if not os.path.exists(CACHE_DIR): os.makedirs(CACHE_DIR, exist_ok=True)
            with open(feat_cache_path, 'wb') as fh:
                pickle.dump(f, fh)
        except:
            pass
    return f


def _calculate_features_internal(df, stock_metrics, macro_data, news_sentiment, earnings_beat_streak, current_price, options_data=None, feature_metrics=None):
    """Internal core logic to calculate full feature set for given df."""
    close  = df['Close'].values
    high   = df['High'].values
    low    = df['Low'].values
    volume = df['Volume'].values
    n = len(df)
    
    f = pd.DataFrame(index=df['Date'] if 'Date' in df.columns else df.index)
    f['Open']   = df['Open'].values
    f['High']   = df['High'].values
    f['Low']    = df['Low'].values
    f['Close']  = df['Close'].values
    f['Volume'] = df['Volume'].values

    # MACD
    exp12 = pd.Series(close).ewm(span=12, adjust=False).mean()
    exp26 = pd.Series(close).ewm(span=26, adjust=False).mean()
    macd  = exp12 - exp26
    sig   = macd.ewm(span=9, adjust=False).mean()
    f['MACD']        = macd.values
    f['MACD_Signal'] = sig.values

    # Bollinger Bands (20)
    sma20  = pd.Series(close).rolling(20).mean()
    std20  = pd.Series(close).rolling(20).std()
    f['BB_Upper'] = (sma20 + 2 * std20).values
    f['BB_Lower'] = (sma20 - 2 * std20).values
    f['BB_Mid']   = sma20.values

    # RSI (14)
    delta = pd.Series(close).diff()
    gain  = delta.where(delta > 0, 0).rolling(14).mean()
    loss  = (-delta.where(delta < 0, 0)).rolling(14).mean()
    rs    = gain / (loss + 1e-9)
    f['RSI_14'] = (100 - 100 / (1 + rs)).values

    # Stochastic (14)
    lo14 = pd.Series(low).rolling(14).min()
    hi14 = pd.Series(high).rolling(14).max()
    k    = 100 * (close - lo14) / (hi14 - lo14 + 1e-9)
    f['STOCH_K'] = k.values
    f['STOCH_D'] = pd.Series(k).rolling(3).mean().values

    # ATR (14)
    tr1 = high - low
    tr2 = np.abs(high - np.roll(close, 1))
    tr3 = np.abs(low  - np.roll(close, 1))
    tr  = np.maximum(tr1, np.maximum(tr2, tr3))
    tr[:1] = tr1[:1]
    f['ATR_14'] = pd.Series(tr).rolling(14).mean().values

    # Moving averages
    f['SMA_20']  = sma20.values
    f['EMA_50']  = pd.Series(close).ewm(span=50,  adjust=False).mean().values
    f['SMA_200'] = pd.Series(close).rolling(200).mean().values
    f['EMA_200'] = pd.Series(close).ewm(span=200, adjust=False).mean().values

    # 52-week ratios
    hi252 = pd.Series(close).rolling(252, min_periods=1).max()
    lo252 = pd.Series(close).rolling(252, min_periods=1).min()
    f['HiRatio_52w'] = (close / (hi252 + 1e-9)).values
    f['LoRatio_52w'] = (close / (lo252 + 1e-9)).values

    # Rate-of-change
    f['ROC_6m']  = pd.Series(close).pct_change(126).values
    f['ROC_12m'] = pd.Series(close).pct_change(252).values

    # Golden cross (SMA50 > SMA200)
    sma50 = pd.Series(close).rolling(50).mean()
    sma200_r = f['SMA_200']
    f['GoldenCross'] = (sma50.values > sma200_r.values).astype(float)

    # Historical volatility (30-day)
    log_ret = np.log(pd.Series(close) / pd.Series(close).shift(1))
    f['HistVol_30'] = log_ret.rolling(30).std().values * np.sqrt(252)

    # Fundamentals
    cp = current_price if current_price and current_price > 0 else (close[-1] if len(close) > 0 else 1)
    pe   = safe(stock_metrics.get('peRatio'),        20.0)
    pb   = safe(stock_metrics.get('pbRatio'),         3.0)
    teps = safe(stock_metrics.get('trailingEps'),     0.0)
    feps = safe(stock_metrics.get('forwardEps'),      0.0)
    revg = safe(stock_metrics.get('revenueGrowth'),   0.0)
    erg  = safe(stock_metrics.get('earningsGrowth'),  0.0)
    pm   = safe(stock_metrics.get('profitMargins'),   0.0)
    de   = safe(stock_metrics.get('debtToEquity'),    75.0)
    roe  = safe(stock_metrics.get('returnOnEquity'),  0.0)
    beta = safe(stock_metrics.get('beta'),            1.0)
    dy   = safe(stock_metrics.get('dividendYield'),   0.0)

    atm  = safe(stock_metrics.get('analystTargetMean'), 0.0)
    aoc  = safe(stock_metrics.get('analystOpinionCount'), 0)
    rcm  = safe(stock_metrics.get('recommendationMean'), 3.0)
    analyst_premium = (atm - cp) / (cp + 1e-9) if atm > 0 and cp > 0 else 0.0
    reliability     = min(aoc / 40.0, 1.0)
    analyst_weighted = analyst_premium * reliability

    f['PE_Ratio']               = pe
    f['PB_Ratio']               = pb
    f['TrailingEPS']            = teps
    f['ForwardEPS']             = feps
    f['RevenueGrowth']          = revg
    f['EarningsGrowth']         = erg
    f['ProfitMargins']          = pm
    f['DebtToEquity']           = de
    f['ReturnOnEquity']         = roe
    f['Beta']                   = beta
    f['DivYield']               = dy
    f['AnalystPremium']         = analyst_premium
    f['AnalystPremiumWeighted'] = analyst_weighted
    f['RecommendationMean']     = rcm

    # Macro features
    date_strs = df['Date'].astype(str).tolist() if 'Date' in df.columns else [None] * n
    vix_series  = merge_series_by_date(date_strs, macro_data.get('vix', []))
    tnx_series  = merge_series_by_date(date_strs, macro_data.get('treasury10y', []))
    etf_data    = macro_data.get('sectorEtf', {}).get('data', [])
    etf_series  = merge_series_by_date(date_strs, etf_data)

    f['VIX']          = vix_series
    f['VIX_20d_Avg']  = pd.Series(vix_series).rolling(20).mean().bfill().ffill().values
    f['Treasury10Y']  = tnx_series

    if etf_series.std() > 0:
        f['SectorETF_60d_Corr'] = pd.Series(close).rolling(60).corr(pd.Series(etf_series)).fillna(0).values
    else:
        f['SectorETF_60d_Corr'] = 0.0

    # Options & Surprises
    f['IV'] = safe(options_data.get('iv'), 0.0) if options_data else np.nan
    f['IV_Rank'] = safe(options_data.get('ivRank'), 0.0) if options_data else np.nan
    f['Put_Call_Ratio'] = safe(options_data.get('putCallRatio'), 0.0) if options_data else np.nan

    eps_val = safe(feature_metrics.get('epsSurpriseAvg4Q'), 0.0) if feature_metrics else 0.0
    f['EPS_Surprise_Avg_4Q'] = max(-50.0, min(50.0, eps_val)) if eps_val != 0.0 else np.nan

    rev_val = safe(feature_metrics.get('revenueSurpriseAvg4Q'), 0.0) if feature_metrics else 0.0
    f['Revenue_Surprise_Avg_4Q'] = max(-50.0, min(50.0, rev_val)) if rev_val != 0.0 else np.nan

    f['ShortFloatPct'] = safe(feature_metrics.get('shortFloatPct'), 0.0) * 100 if feature_metrics else np.nan
    f['DaysToCover'] = safe(feature_metrics.get('daysToCover'), 0.0) if feature_metrics else np.nan

    # Insider activity — net sell ratio is clipped to [-1, 1]; count is non-negative
    _insider_sell = max(-1.0, min(1.0, safe(feature_metrics.get('insiderNetSellRatio90d'), 0.0))) if feature_metrics else 0.0
    _insider_tx   = max(0.0, safe(feature_metrics.get('insiderTxCount90d'), 0.0)) if feature_metrics else 0.0
    f['InsiderNetSellRatio_90d'] = 0.0
    f['InsiderTxCount_90d'] = 0.0
    if n >= 63:
        f.iloc[-63:, f.columns.get_loc('InsiderNetSellRatio_90d')] = _insider_sell
        f.iloc[-63:, f.columns.get_loc('InsiderTxCount_90d')]      = _insider_tx
    else:
        f.iloc[:, f.columns.get_loc('InsiderNetSellRatio_90d')] = _insider_sell
        f.iloc[:, f.columns.get_loc('InsiderTxCount_90d')]      = _insider_tx

    f['NewsSentiment']      = news_sentiment
    f['EarningsBeatStreak'] = earnings_beat_streak

    if 'Date' in df.columns:
        months = pd.to_datetime(df['Date']).dt.month.values
    else:
        months = np.ones(n, dtype=int)
    f['Month_Sin']     = np.sin(2 * np.pi * months / 12)
    f['Month_Cos']     = np.cos(2 * np.pi * months / 12)
    f['EarningsSeason'] = np.isin(months, [1, 4, 7, 10]).astype(float)

    # Lags & Returns
    close_s = pd.Series(close)
    f['Close_lag_5']  = close_s.shift(5).values
    f['Close_lag_10'] = close_s.shift(10).values
    f['Close_lag_20'] = close_s.shift(20).values
    f['Volume_lag_5'] = pd.Series(volume).shift(5).values

    f['ROC_5d']    = close_s.pct_change(5).values
    f['ROC_20d']   = close_s.pct_change(20).values
    f['Return_1d'] = close_s.pct_change(1).values
    f['Return_5d'] = close_s.pct_change(5).values
    f['Return_20d']= close_s.pct_change(20).values

    f['PriceToHigh_5d']  = (close_s / (close_s.rolling(5).max()  + 1e-9)).values
    f['PriceToHigh_20d'] = (close_s / (close_s.rolling(20).max() + 1e-9)).values
    f['PriceToLow_20d']  = (close_s / (close_s.rolling(20).min()  + 1e-9)).values

    daily_ret = close_s.pct_change().fillna(0)
    f['VolumePriceTrend'] = (daily_ret * pd.Series(volume)).rolling(10).sum().values

    f['EMA_Slope_10'] = close_s.ewm(span=10, adjust=False).mean().diff(3).values
    f['EMA_Slope_20'] = close_s.ewm(span=20, adjust=False).mean().diff(3).values

    # Rolling Return Statistics (Vectorized)
    ret20 = daily_ret.rolling(20)
    f['RollingMean_20d'] = ret20.mean().values
    f['RollingStd_20d']  = ret20.std().values
    
    # Native Pandas skew (Gold standard for speed & numerical stability)
    f['RollingSkew_20d'] = ret20.skew().values
    
    # [LEGACY/MANUAL OPTION] Vectorized Skewness via Power Sums
    # (Kept here for reference; numerically equivalent but slightly less stable than native skew)
    # def rolling_skew_vectorized(s, window=20):
    #     m = s.rolling(window).mean()
    #     std = s.rolling(window).std()
    #     m1, m2, m3 = m, (s**2).rolling(window).mean(), (s**3).rolling(window).mean()
    #     return ((m3 - 3*m1*m2 + 2*m1**3) / (std**3 + 1e-9)).values
    # f['RollingSkew_20d'] = rolling_skew_vectorized(daily_ret, window=20)

    f['RollingSharpe_20d'] = (ret20.mean() / (ret20.std() + 1e-9)).values

    # Phase 1 Macro
    # Inject lastEarningsDate into stock_metrics for _add_macro_features
    if feature_metrics and 'lastEarningsDate' in feature_metrics:
        stock_metrics = dict(stock_metrics)  # don't mutate caller's dict
        stock_metrics['lastEarningsDate'] = feature_metrics.get('lastEarningsDate')

    f = _add_macro_features(f, date_strs, macro_data, close_s, f['HistVol_30'].values, stock_metrics)

    # ── Item 02: Post-earnings drift counter + cum return + vol ratio ─────────
    earnings_hist = (feature_metrics or {}).get('earningsDateHistory', [])
    earnings_dates_list = []
    for e in earnings_hist:
        try:
            if e.get('date'):
                earnings_dates_list.append(datetime.fromisoformat(str(e['date'])[:10]).date())
        except Exception:
            pass
    earnings_dates_list.sort()

    date_arr = pd.to_datetime(df['Date']).dt.date.values if 'Date' in df.columns else []
    n_rows = len(df)
    post_day_n    = np.zeros(n_rows, dtype=float)
    cum_ret_arr   = np.zeros(n_rows, dtype=float)
    vol_ratio_arr = np.ones(n_rows, dtype=float)

    if earnings_dates_list and len(date_arr) > 0:
        for i, d in enumerate(date_arr):
            # Most recent earnings date on or before d
            past = [(d - e).days for e in earnings_dates_list if d >= e]
            if past:
                day_n = min(min(past), 21)
                post_day_n[i] = day_n

                if day_n < 21:
                    # Index of the earnings date in historical data
                    earn_date = earnings_dates_list[
                        next(j for j, e in enumerate(earnings_dates_list) if (d - e).days == min(past))
                    ]
                    earn_idx = np.searchsorted(date_arr, earn_date)
                    earn_close = close[earn_idx] if earn_idx < len(close) else close[i]
                    cum_ret_arr[i] = (close[i] - earn_close) / (earn_close + 1e-9)

                    pre_vol  = volume[max(0, earn_idx - 20):earn_idx].mean() if earn_idx > 0 else volume[i]
                    post_vol = volume[earn_idx:i + 1].mean() if i > earn_idx else volume[i]
                    vol_ratio_arr[i] = post_vol / (pre_vol + 1e-9)

    f['PostEarnings_DayN']    = post_day_n
    f['PostEarnings_CumReturn'] = cum_ret_arr
    f['PostEarnings_VolRatio']  = np.clip(vol_ratio_arr, 0.1, 10.0)

    # ── Item 03: EPS revision velocity (scalar broadcast) ──────────────────
    fm = feature_metrics or {}
    f['EPS_Revision_7d_0Q']    = float(fm.get('epsRevision7d_0Q')   or 0.0)
    f['EPS_Revision_7d_1Q']    = float(fm.get('epsRevision7d_1Q')   or 0.0)
    f['Revenue_Est_Growth_0Q'] = float(fm.get('revenueEstGrowth_0Q') or 0.0)
    f['Revenue_Est_Growth_1Q'] = float(fm.get('revenueEstGrowth_1Q') or 0.0)
    f['EPS_Rev_Up7d']          = float(fm.get('epsRevisionsUp7d')   or 0.0)
    f['EPS_Rev_Down7d']        = float(fm.get('epsRevisionsDown7d') or 0.0)

    # ── Item 04: Analyst upgrade/downgrade recency (scalar broadcast) ───────
    f['Upgrade_Score_7d']  = float(fm.get('upgradeScore7d')  or 0.0)
    f['Upgrade_Score_30d'] = float(fm.get('upgradeScore30d') or 0.0)

    # ── Item 05: Pre/post-market microstructure (scalar, most recent row) ───
    f['PreMarket_GapPct']      = float(fm.get('preMarketChangePct')   or 0.0)
    f['PostMarket_GapPct']     = float(fm.get('postMarketChangePct')  or 0.0)
    f['FiftyTwoWeek_PosRatio'] = float(fm.get('fiftyTwoWeekPosRatio') or 0.5)

    # ── Item 06: Institution ownership (scalar broadcast) ───────────────────
    f['Institution_PctHeld']  = float(fm.get('instPctHeld')  or 0.0)
    f['Institution_PctDelta'] = float(fm.get('instPctDelta') or 0.0)

    # ── Item 08: Peer relative strength (scalar broadcast) ──────────────────
    f['Peer_RS_5d'] = float(fm.get('peerRS5d') or 0.0)

    # Reorder and fill
    f = f[FEATURE_COLUMNS]
    f['Days_To_Next_Earnings'] = f['Days_To_Next_Earnings'].fillna(999)  # 999 = "unknown/far away"
    f['Days_Since_Last_Earnings'] = f['Days_Since_Last_Earnings'].fillna(45)  # 45 = typical quarter midpoint
    f = f.ffill().bfill().fillna(0)  # Now safe to run the general fillna
    return f


# ============================================================================
# MLP MODEL (sklearn — CPU-portable, no AVX/AVX2 requirement)
# ============================================================================
def build_mlp(seed=SEED):
    # Widened to handle expanded feature set + regime features (~109 features total)
    return MLPRegressor(
        hidden_layer_sizes=(256, 128, 64, 32),
        activation='relu',
        solver='adam',
        learning_rate_init=0.001,
        max_iter=N_EPOCHS,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=8,
        random_state=seed,
    )


def _dirichlet_smooth(probs, alpha=REGIME_PROB_SMOOTHING_ALPHA):
    """Mix regime probs with a uniform prior. Mirrors predict_core.py."""
    if probs is None or alpha <= 0.0:
        return probs
    n_clusters = probs.shape[1]
    uniform = 1.0 / n_clusters
    return (1.0 - alpha) * probs + alpha * uniform


def build_regime_detector(market_vec_norm, fitted_model, n_clusters):
    """
    Use a fitted model (from select_regime_k) to predict regimes.
    Falls back to KMeans when no GMM is available — and in that case derives
    soft probabilities via a softmax over negative cluster distances so the
    output is never a hard one-hot. All return paths run probs through
    `_dirichlet_smooth()` so a confident GMM still surfaces with a small
    reserved mass on the other regimes. Mirrors the predict_core.py version.
    """
    from sklearn.cluster import KMeans

    if fitted_model is not None:
        try:
            labels = fitted_model.predict(market_vec_norm)
            probs = fitted_model.predict_proba(market_vec_norm)
            return labels, _dirichlet_smooth(probs)
        except:
            pass

    # Fallback to KMeans if GMM not provided or failed
    try:
        km = KMeans(n_clusters=n_clusters, n_init=5, random_state=SEED)
        labels = km.fit_predict(market_vec_norm)
        distances = km.transform(market_vec_norm)
        logits = -(distances - distances.min(axis=1, keepdims=True))
        exp = np.exp(logits)
        probs = exp / exp.sum(axis=1, keepdims=True)
        return labels, _dirichlet_smooth(probs)
    except:
        n = len(market_vec_norm)
        uniform = np.full((n, n_clusters), 1.0 / n_clusters, dtype=np.float32)
        return np.zeros(n, dtype=int), uniform


def select_regime_k(market_vec, min_state_frac=0.15, max_flip_rate=0.30):
    """
    K selection gate: evaluate K=3 only for speed.
    Returns: (selected K, fitted_model, scaler)
    """
    from sklearn.mixture import GaussianMixture
    from sklearn.preprocessing import StandardScaler

    scaler = StandardScaler()
    market_vec_norm = scaler.fit_transform(market_vec)

    best_model = None
    best_k = 3

    for k in [3, 4]:
        try:
            gmm = GaussianMixture(n_components=k, covariance_type='full',
                                  max_iter=100, random_state=SEED, n_init=5)
            gmm.fit(market_vec_norm)
            labels = gmm.predict(market_vec_norm)
        except:
            continue

        # Gate 1: State size
        counts = np.bincount(labels, minlength=k) / len(labels)
        if np.any(counts < min_state_frac):
            continue

        # Gate 2: Temporal stability
        flips = np.mean(np.diff(labels) != 0) if len(labels) > 1 else 0.0
        if flips > max_flip_rate:
            continue

        # If it passes, store as best
        best_model = gmm
        best_k = k

    return best_k, best_model, scaler


def make_sequences(scaled, targets_1d, targets_1w, targets_6m, targets_1y):
    """
    Build (X, y) sequences of length SEQ_LEN.
    Y columns: [p1d, p1w, p6m, p1y]
    """
    n_samples = len(scaled) - SEQ_LEN
    if n_samples <= 0:
        return np.array([], dtype=np.float32), np.array([], dtype=np.float32)

    from numpy.lib.stride_tricks import sliding_window_view
    X = sliding_window_view(scaled[:-1], (SEQ_LEN, scaled.shape[1])).squeeze(1)
    X = X.reshape(n_samples, -1)

    Y = np.column_stack([
        targets_1d[SEQ_LEN:],
        targets_1w[SEQ_LEN:],
        targets_6m[SEQ_LEN:],
        targets_1y[SEQ_LEN:],
    ])

    return X.astype(np.float32), Y.astype(np.float32)


# ============================================================================
# CONFIDENCE SCORE
# ============================================================================
def confidence_score(cv_mape, history_years, imputed_fields, analyst_count):
    pts = 0
    breakdown = {}

    # CV MAPE (40 pts)
    if cv_mape < 5:
        pts += 40
        breakdown['cv_mape'] = 40
    elif cv_mape < 10:
        pts += 30
        breakdown['cv_mape'] = 30
    elif cv_mape < 20:
        pts += 15
        breakdown['cv_mape'] = 15
    else:
        breakdown['cv_mape'] = 0

    # History depth (25 pts)
    if history_years >= 5:
        pts += 25
        breakdown['history'] = 25
    elif history_years >= 4:
        pts += 20
        breakdown['history'] = 20
    elif history_years >= 3:
        pts += 12
        breakdown['history'] = 12
    elif history_years >= 2:
        pts += 5
        breakdown['history'] = 5
    else:
        breakdown['history'] = 0

    # Feature completeness (20 pts)
    n_imp = len(imputed_fields)
    if n_imp == 0:
        pts += 20
        breakdown['features'] = 20
    elif n_imp <= 2:
        pts += 14
        breakdown['features'] = 14
    elif n_imp <= 5:
        pts += 8
        breakdown['features'] = 8
    else:
        breakdown['features'] = 0

    # Analyst coverage (15 pts)
    if analyst_count >= 10:
        pts += 15
        breakdown['analyst'] = 15
    elif analyst_count >= 5:
        pts += 10
        breakdown['analyst'] = 10
    elif analyst_count >= 1:
        pts += 5
        breakdown['analyst'] = 5
    else:
        breakdown['analyst'] = 0

    final_score = min(pts, 100)
    print(f"[DEBUG] Confidence score breakdown: cv_mape={breakdown.get('cv_mape', 0)}, history={breakdown.get('history', 0)}, features={breakdown.get('features', 0)}, analyst={breakdown.get('analyst', 0)} → total={final_score}", file=sys.stderr)

    return final_score


# ============================================================================
# LEGACY METRIC ANALYSIS (kept for backward compat)
# ============================================================================
def metric_analysis(df, stock_metrics, news_sentiment, growth_rate, is_uptrend, earnings_beat_streak, external_tech_score=0.0, consensus_value=0.0, analyst_weighted=0.0, analyst_count=0):
    current_price = df['Close'].iloc[-1]
    rsi       = df['RSI_14'].iloc[-1] if 'RSI_14' in df.columns else 50.0
    sma20_val = df['SMA_20'].iloc[-1]  if 'SMA_20'  in df.columns else current_price
    ema50_val = df['EMA_50'].iloc[-1]  if 'EMA_50'  in df.columns else current_price
    macd_val  = df['MACD'].iloc[-1]    if 'MACD'    in df.columns else 0.0
    sig_val   = df['MACD_Signal'].iloc[-1] if 'MACD_Signal' in df.columns else 0.0
    stoch_k   = df['STOCH_K'].iloc[-1] if 'STOCH_K' in df.columns else 50.0
    atr_val   = df['ATR_14'].iloc[-1]  if 'ATR_14'  in df.columns else 0.0
    bb_upper  = df['BB_Upper'].iloc[-1] if 'BB_Upper' in df.columns else current_price
    bb_lower  = df['BB_Lower'].iloc[-1] if 'BB_Lower' in df.columns else current_price
    avg_vol   = df['Volume'].tail(20).mean()
    cur_vol   = df['Volume'].iloc[-1]
    vol_ratio = cur_vol / avg_vol if avg_vol > 0 else 1.0

    total_impact = 0.0
    # Internal heuristics (dampened to prevent double-counting with external_tech_score)
    if rsi > 75:   total_impact -= 0.015
    elif rsi < 25: total_impact += 0.015

    if is_uptrend: total_impact += 0.02
    else:          total_impact -= 0.01  # less penalizing for stable/consolidating stocks

    capped_growth = max(-10.0, min(10.0, growth_rate))
    total_impact += (capped_growth / 100) * 0.03
    total_impact += news_sentiment * 0.015
    
    # ── Reliability scalar (used by both tech score and consensus below) ──
    # Scales down signals for low-coverage stocks so a micro-cap with 4 analysts
    # doesn't get the same uplift weighting as a large-cap with 40+ analysts.
    _reliability = min(analyst_count / 40.0, 1.0)

    # ── External Technical Indicator Influence ──
    # Reliability-weighted and capped at 2% max so a momentum spike with 10+ buy
    # signals on a low-coverage stock doesn't dominate the impact multiplier.
    _ext_tech_contribution = external_tech_score * 0.005 * _reliability
    total_impact += min(_ext_tech_contribution, 0.02)

    # ── Analyst Consensus Influence (0.0 to 1.0) ──
    # Reliability-weighted so low-coverage stocks (e.g. 4 analysts) don't get the
    # same bullish lift as well-covered stocks (e.g. 40+ analysts). Without this,
    # a "buy" rating on a stock where analysts' actual price target is -38% vs current
    # price would still add the full +3.75% — drowning out the bearish target signal.
    total_impact += consensus_value * 0.05 * _reliability

    # ── Analyst Numerical Target Premium (0.0 to 1.0) ──
    # Directly nudges prediction toward the analyst target mean.
    # analyst_weighted already incorporates reliability (analystOpinionCount / 40),
    # so no further reliability scaling is needed here. Deep-coverage stocks get a
    # modest boost (up to 1.5x) to reward strong analyst alignment.
    analyst_coverage_boost = min(analyst_count / 40.0, 1.5)
    total_impact += analyst_weighted * 0.05 * analyst_coverage_boost

    # ── Earnings Beat Streak influence (0-4 quarters) ──
    # Adds ~1.0% per beat (was 0.5%). Max +4%.
    total_impact += earnings_beat_streak * 0.01

    # ── High-Beta / Valuation Stretch Penalty ──
    # High-beta stocks near 52w highs are prone to sharp mean-reversion.
    _beta = safe(stock_metrics.get('beta'), 1.0)
    _hi_ratio = float(df['HiRatio_52w'].iloc[-1]) if 'HiRatio_52w' in df.columns else 0.0
    if _beta > 2.5 and _hi_ratio > 0.95:
        stretch_penalty = 1.0 - ((_beta - 2.5) * 0.015)
        total_impact += stretch_penalty - 1.0

    return {
        "rsi": {
            "value": round(float(rsi), 2),
            "signal": "overbought" if rsi > 70 else ("oversold" if rsi < 30 else "neutral"),
            "description": "RSI (14)"
        },
        "moving_averages": {
            "sma20":          round(float(sma20_val), 2),
            "ema50":          round(float(ema50_val), 2),
            "price_position": "above" if current_price > sma20_val else "below",
            "signal":         "bullish" if sma20_val > ema50_val else "bearish",
            "description":    "SMA20 / EMA50 trend",
        },
        "volume": {
            "current_volume": round(float(cur_vol), 0),
            "average_volume": round(float(avg_vol), 0),
            "ratio":          round(float(vol_ratio), 2),
            "signal":         "above_average" if vol_ratio > 1.2 else ("below_average" if vol_ratio < 0.8 else "average"),
            "description":    "Volume conviction",
        },
        "macd": {
            "macd_line":   round(float(macd_val), 4),
            "signal_line": round(float(sig_val), 4),
            "signal":      "bullish" if macd_val > sig_val else "bearish",
            "description": "MACD",
        },
        "stochastic": {
            "k_value": round(float(stoch_k), 2),
            "signal":  "overbought" if stoch_k > 80 else ("oversold" if stoch_k < 20 else "neutral"),
            "description": "Stochastic (14)",
        },
        "atr": {"value": round(float(atr_val), 2), "description": "ATR (14)"},
        "bollinger_bands": {
            "upper": round(float(bb_upper), 2),
            "lower": round(float(bb_lower), 2),
            "description": "Bollinger Bands (20)",
        },
        "growth_and_trend": {
            "growth_rate_20d":         round(float(growth_rate), 2),
            "is_uptrend":              bool(is_uptrend),
            "combined_classification": "strong_bullish" if (is_uptrend and growth_rate > 2) else ("bullish" if is_uptrend else "bearish"),
            "description":             "20-day growth & trend",
        },
        "sentiment": {
            "news_sentiment_score": round(float(news_sentiment), 4),
            "signal": "positive" if news_sentiment > 0.3 else ("negative" if news_sentiment < -0.3 else "neutral"),
            "description": "News sentiment",
        },
        "fundamentals": {
            "pe_ratio":  safe(stock_metrics.get('peRatio')),
            "pb_ratio":  safe(stock_metrics.get('pbRatio')),
            "market_cap": safe(stock_metrics.get('marketCap')),
            "description": "Core valuation",
        },
        "external_indicator_score": {
            "value": round(float(external_tech_score), 2),
            "impact": round(float(external_tech_score * 0.0025), 4),
            "description": "External technical indicator score",
        },
        "analyst_consensus": {
            "value": round(float(consensus_value), 2),
            "impact": round(float(consensus_value * 0.02), 4),
            "description": "Analyst recommendation summary",
        },
        "earnings_beats": {
            "value": int(earnings_beat_streak),
            "impact": round(float(earnings_beat_streak * 0.005), 4),
            "description": "Last 4 quarters of earnings beats (relative to analyst estimates)",
        },
        "total_metric_impact":   round(float(total_impact), 4),
        "impact_classification": (
            "very_bullish" if total_impact > 0.08 else
            "bullish"      if total_impact > 0.04 else
            "neutral"      if total_impact > -0.04 else
            "bearish"      if total_impact > -0.08 else
            "very_bearish"
        ),
    }


# ============================================================================
# MAIN PREDICTION FUNCTION
# ============================================================================
def _sanitize_predictions(result: dict) -> dict:
    """Clamp predicted_price / predicted_change_pct to physically plausible
    bounds. Catches the case where the MLP extrapolates wildly (e.g. PLD
    returning predicted_price=-23 with confidence=90, which would otherwise
    get persisted as a -116% high-confidence call and corrupt downstream
    accuracy metrics).

    Floors price at 0.01. Per-horizon change-pct bounds:
      1w  : ±15%
      1m  : ±30%
      6m  : ±60%
      1y  : ±100%

    When any clamp fires for a horizon, that horizon's confidence_score is
    knocked down to 25 (a clamped prediction is a low-trust prediction).
    Writes a one-line stderr note so the clamp event is visible in logs.
    """
    horizons = [
        ('1w', 15.0),
        ('1m', 30.0),
        ('6m', 60.0),
        ('1y', 100.0),
    ]
    ticker = result.get('ticker', '?')
    for h, bound in horizons:
        price_key = f'predicted_price_{h}'
        pct_key   = f'predicted_change_pct_{h}'
        conf_key  = f'confidence_score_{h}'
        price = result.get(price_key)
        pct   = result.get(pct_key)
        if price is None or pct is None:
            continue
        clamped = False
        # Floor price at 0.01 — negative prices are unphysical
        if isinstance(price, (int, float)) and price < 0.01:
            print(f"[sanitize] {ticker} {h}: price {price} → 0.01 (was negative)", file=sys.stderr)
            result[price_key] = 0.01
            clamped = True
        # Clamp change pct
        if isinstance(pct, (int, float)) and abs(pct) > bound:
            new_pct = max(-bound, min(bound, pct))
            print(f"[sanitize] {ticker} {h}: change_pct {pct} → {new_pct} (out of ±{bound}% bound)", file=sys.stderr)
            result[pct_key] = new_pct
            clamped = True
        if clamped:
            # Knock confidence to 25 — a clamped output is low-trust
            result[conf_key] = 25
    return result


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
    # Numeric fallback when the categorical key is missing or unrecognized —
    # covers null, empty string, and Yahoo's 'none' / 'underperform' /
    # 'outperform' for thinly-covered names. Yahoo's recommendationMean scale
    # runs 1.0 (Strong Buy) → 5.0 (Strong Sell), mapped linearly to [-1, 1]
    # with 3.0 (Hold) → 0.
    if consensus_key not in consensus_map:
        rcm = stock_metrics.get('recommendationMean')
        if rcm is not None:
            try:
                rcm_f = float(rcm)
                if 1.0 <= rcm_f <= 5.0:
                    consensus_value = max(-1.0, min(1.0, (3.0 - rcm_f) / 2.0))
            except (TypeError, ValueError):
                pass

    # Tertiary fallback: derive consensus from `recommendationsHistory` — the
    # per-period strongBuy/buy/hold/sell/strongSell counts. Fires when Yahoo
    # returns 'none' for recommendationKey AND null for recommendationMean
    # but per-period trend votes are still populated (LPG-class thinly-covered
    # names hit this path). Computes a synthetic 1-5 weighted rating from the
    # most-recent period and reuses the recommendationMean mapping above.
    if consensus_value == 0.0 and consensus_key not in consensus_map:
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
        raise ValueError(f"Insufficient data: {len(df)} rows, need ≥ 365.")

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

    # ── Phase 2-3: Regime detection and integration ─────────────────────────
    # Build compact market-state vector for regime detector
    regime_vec_cols = ['VIX', 'HistVol_30', 'HYG_LQD_Ratio', 'RS_vs_SPY_20d', 'DXY_Return_20d',
                       'CurveSlope_10M3M', 'RollingMean_20d', 'RollingStd_20d',
                       'WorldBank_GDP', 'WorldBank_Inflation']

    # Ensure all regime features exist; fill missing with 0
    for col in regime_vec_cols:
        if col not in feat_df.columns:
            feat_df[col] = 0.0

    regime_vec = feat_df[regime_vec_cols].values.astype(np.float32)
    # Sanitize: some international/REIT tickers (e.g. SRU-UN.TO, ENR.DE)
    # produce inf/NaN in one of the macro ratios (DXY_Return_20d divided by
    # a zero-window sample, etc.) which crashes the downstream sklearn
    # MinMaxScaler / GaussianMixture with "Input X contains infinity".
    # Replace inf/-inf/NaN with 0 so the regime detector can proceed
    # instead of 500-ing the entire prediction.
    regime_vec = np.nan_to_num(regime_vec, nan=0.0, posinf=0.0, neginf=0.0)

    # Select K using gate logic (now returns fitted model)
    k, fitted_regime_model, regime_scaler = select_regime_k(regime_vec)
    regime_vec_norm = regime_scaler.transform(regime_vec)

    # Use already-fitted model — no re-training.
    regime_labels, regime_probs = build_regime_detector(regime_vec_norm, fitted_regime_model, k)

    # Add regime one-hot columns (pad to K=4 for consistent feature vector size)
    for i in range(4):
        if i < k:
            feat_df[f'Regime_{i}'] = (regime_labels == i).astype(float)
        else:
            feat_df[f'Regime_{i}'] = 0.0

    # Add regime probability columns (soft, from GMM; hard assignment if KMeans fallback)
    if regime_probs is not None:
        for i in range(4):
            if i < k:
                feat_df[f'Regime_Prob_{i}'] = regime_probs[:, i]
            else:
                feat_df[f'Regime_Prob_{i}'] = 0.0
    else:
        # KMeans fallback: hard one-hot assignment
        for i in range(4):
            if i < k:
                feat_df[f'Regime_Prob_{i}'] = (regime_labels == i).astype(float)
            else:
                feat_df[f'Regime_Prob_{i}'] = 0.0

    # Add interaction terms (regime × market signals)
    feat_df['Regime_x_PC_Ratio'] = (feat_df.get('Regime_0', 0) *
                                     feat_df.get('Put_Call_Ratio', 1.0).fillna(0))
    feat_df['Regime_x_HYG_LQD'] = (feat_df.get('Regime_1', 0) *
                                    feat_df.get('HYG_LQD_Ratio', 1.0).fillna(0))
    feat_df['Regime_x_RS_SPY'] = (feat_df.get('Regime_2', 0) *
                                   feat_df.get('RS_vs_SPY_20d', 0).fillna(0))

    # Extend FEATURE_COLUMNS dynamically to include regime columns
    regime_cols = ([f'Regime_{i}' for i in range(4)] +
                   [f'Regime_Prob_{i}' for i in range(4)] +
                   ['Regime_x_PC_Ratio', 'Regime_x_HYG_LQD', 'Regime_x_RS_SPY'])

    # Only add regime columns that are actually computed (not already in FEATURE_COLUMNS)
    extended_feature_cols = FEATURE_COLUMNS + [col for col in regime_cols if col not in FEATURE_COLUMNS]

    # Reorder feat_df to match extended columns, fill missing with 0
    for col in extended_feature_cols:
        if col not in feat_df.columns:
            feat_df[col] = 0.0
    feat_df = feat_df[extended_feature_cols]
    feat_df = feat_df.ffill().bfill().fillna(0)

    n_features = len(extended_feature_cols)
    raw = feat_df.values.astype(np.float32)
    # Same sanitization as the regime_vec above. ffill/bfill/fillna(0) on the
    # DataFrame handles NaN but NOT inf/-inf — and some macro ratios (e.g.
    # FX-relative momentum on .TO / .DE listings against SPY) divide by a
    # zero-window sample and produce inf, which crashes
    # MinMaxScaler.fit_transform with "Input X contains infinity".
    raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)

    # Store regime info for output
    current_regime_idx = int(regime_labels[-1])
    current_regime_probs = regime_probs[-1].tolist() if regime_probs is not None else (regime_labels[-1:] == np.arange(k)).astype(float).tolist()
    # Pad to K=4 width
    while len(current_regime_probs) < 4:
        current_regime_probs.append(0.0)
    regime_names = {0: 'risk_on_trending', 1: 'risk_off_stress', 2: 'high_vol_choppy', 3: 'low_vol_mean_reverting'}
    regime_info = {
        'k': k,
        'current_regime': current_regime_idx,
        'current_regime_probs': [round(p, 3) for p in current_regime_probs[:k]],
        'regime_names': [regime_names[i] for i in range(k)]
    }

    # ---- Scale features ----
    scaler = MinMaxScaler(feature_range=(0, 1))
    # Scale close separately for target inverse-transform
    close_col_idx = FEATURE_COLUMNS.index('Close')

    # Get analyst_weighted for metric_analysis
    cp_tmp = current_price if current_price > 0 else (df['Close'].iloc[-1] if len(df) > 0 else 1)
    atm_tmp = safe(stock_metrics.get('analystTargetMean'), 0.0)
    aoc_tmp = safe(stock_metrics.get('analystOpinionCount'), 0)
    analyst_premium_tmp = (atm_tmp - cp_tmp) / (cp_tmp + 1e-9) if atm_tmp > 0 and cp_tmp > 0 else 0.0
    reliability_tmp     = min(aoc_tmp / 40.0, 1.0)
    analyst_weighted_val = analyst_premium_tmp * reliability_tmp

    scaled = scaler.fit_transform(raw)

    # ---- Build training targets ----
    # For each timestep t, target_6m = close at t+126, target_1y = close at t+252
    # We only have targets where the future exists in the data.
    T6  = 126   # ~6 months
    T12 = 252   # ~12 months
    T18 = 378   # ~18 months (for trajectory)

    # Use scaled close values as regression targets
    scaled_close = scaled[:, close_col_idx]

    T1  = 1    # 1 trading day
    T5  = 5    # 1 trading week
    targets_1d  = np.zeros(len(scaled))
    targets_1w  = np.zeros(len(scaled))
    targets_6m  = np.zeros(len(scaled))
    targets_1y  = np.zeros(len(scaled))
    for i in range(len(scaled)):
        targets_1d[i]  = scaled_close[min(i + T1,  len(scaled) - 1)]
        targets_1w[i]  = scaled_close[min(i + T5,  len(scaled) - 1)]
        targets_6m[i]  = scaled_close[min(i + T6,  len(scaled) - 1)]
        targets_1y[i]  = scaled_close[min(i + T12, len(scaled) - 1)]

    X, Y = make_sequences(scaled, targets_1d, targets_1w, targets_6m, targets_1y)

    if len(X) < 50:
        raise ValueError("Not enough sequences for training.")

    # ---- Single holdout validation (last 20% of sequences as test) ----
    # Replaces 3-fold walk-forward CV (~30s) with a single split (~0s extra
    # compute — the split is free; we reuse the final model's val_loss).
    split_idx = int(len(X) * 0.8)
    X_hold, Y_hold = X[split_idx:], Y[split_idx:]

    # ---- Train final model on full data ----
    model = build_mlp()
    model.fit(X, Y)

    # Compute cv_mae from the held-out 20%
    if len(X_hold) > 0:
        hold_pred = model.predict(X_hold)
        dummy_pred = np.zeros((len(hold_pred), n_features), dtype=np.float32)
        dummy_pred[:, close_col_idx] = hold_pred[:, 2]
        pred_prices_hold = scaler.inverse_transform(dummy_pred)[:, close_col_idx]

        dummy_act = np.zeros((len(Y_hold), n_features), dtype=np.float32)
        dummy_act[:, close_col_idx] = Y_hold[:, 2]
        actual_prices_hold = scaler.inverse_transform(dummy_act)[:, close_col_idx]

        cv_mae  = float(mean_absolute_error(actual_prices_hold, pred_prices_hold))
        cv_rmse = float(np.sqrt(mean_squared_error(actual_prices_hold, pred_prices_hold)))
    else:
        cv_mae  = float(current_price * 0.05)
        # Normal-ish residual heuristic: RMSE ≈ MAE × sqrt(π/2). Only fires when
        # holdout is empty, so it's a placeholder, not a calibrated value.
        cv_rmse = cv_mae * 1.253
    cv_mape = (cv_mae / (current_price + 1e-9)) * 100

    # ---- Legacy metric analysis ----
    m_analysis = metric_analysis(feat_df, stock_metrics, news_sentiment,
                                  growth_rate, is_uptrend, earnings_beat_streak, external_tech_score, consensus_value, analyst_weighted_val,
                                  analyst_count=int(safe(stock_metrics.get('analystOpinionCount'), 0)))

    impact_multiplier = 1.0 + m_analysis['total_metric_impact']

    # ── World Bank Consumption Heuristic (Phase 4) ──
    consumer_multiplier = 1.0
    sector = stock_metrics.get('sector', '')
    if sector in ['Consumer Cyclical', 'Consumer Defensive']:
        cons_growth = feat_df['WorldBank_Consumption'].iloc[-1]
        consumer_multiplier = 1.0 + max(-0.03, min(0.03, cons_growth * 0.005))

    impact_multiplier *= consumer_multiplier

    # ---- Deterministic 6m / 12m predictions ----
    last_seq = scaled[-SEQ_LEN:].flatten().reshape(1, -1)
    pred_scaled = model.predict(last_seq)[0]  # [p1d, p1w, p6m, p1y]

    def inverse_close(scaled_val):
        dummy = np.zeros((1, n_features), dtype=np.float32)
        dummy[0, close_col_idx] = float(scaled_val)
        return float(scaler.inverse_transform(dummy)[0, close_col_idx])

    predicted_price_6m = current_price + (inverse_close(pred_scaled[2]) - current_price) * impact_multiplier
    predicted_price_1y = current_price + (inverse_close(pred_scaled[3]) - current_price) * impact_multiplier

    # ---- 1-week prediction: blend MLP T+5 output with trajectory anchor ----
    # The T+5 MLP head is noisy (5-day returns are ~90% noise; joint training with
    # 6m/1y targets leaves the T+5 head under-trained). We blend it 30/70 with the
    # trajectory interpolation and hard-cap at ±2×ATR to prevent extreme swings.
    _mlp_1w_raw = current_price + (inverse_close(pred_scaled[1]) - current_price) * impact_multiplier
    _traj_anchor_1w = current_price + (predicted_price_6m - current_price) * (T5 / T6)
    _blended_1w = 0.30 * _mlp_1w_raw + 0.70 * _traj_anchor_1w

    # ATR-based cap: weekly move cannot exceed 2× the 14-day ATR
    _atr_1w = float(feat_df['ATR_14'].iloc[-1]) if 'ATR_14' in feat_df.columns else current_price * 0.02
    _max_move_1w = 2.0 * _atr_1w * np.sqrt(5)   # scale daily ATR to 5 days
    predicted_price_1w = float(np.clip(
        _blended_1w,
        current_price - _max_move_1w,
        current_price + _max_move_1w,
    ))

    # ---- Monte Carlo Dropout — 18-month trajectory ----
    # t+5 (1 week) is prepended so it appears as the first chart point
    WAYPOINTS = [T5] + list(range(21, 379, 21))  # t+5, t+21, t+42, ... t+378

    # Batched MC uncertainty
    feature_stds = scaled[-20:].std(axis=0)
    feature_stds = np.clip(feature_stds, 1e-4, None)
    tiled_stds = np.tile(feature_stds, SEQ_LEN).reshape(1, -1).astype(np.float32)
    rng = np.random.default_rng(SEED)
    
    noise_batch = rng.normal(0, 1, (MC_RUNS, *last_seq.shape)).astype(np.float32)
    noise_batch *= (tiled_stds * 0.1)
    noisy_batch = last_seq + noise_batch.squeeze(1)
    mc_preds = model.predict(noisy_batch)  # single call, MC_RUNS rows

    # Batch inverse transform
    dummy_mc = np.zeros((MC_RUNS, n_features), dtype=np.float32)
    dummy_mc[:, close_col_idx] = mc_preds[:, 2]
    mc_6m_bases = scaler.inverse_transform(dummy_mc)[:, close_col_idx]
    mc_6m = current_price + (mc_6m_bases - current_price) * impact_multiplier

    dummy_mc[:, close_col_idx] = mc_preds[:, 3]
    mc_12m_bases = scaler.inverse_transform(dummy_mc)[:, close_col_idx]
    mc_12m = current_price + (mc_12m_bases - current_price) * impact_multiplier

    # Spread from MC (uncertainty bands only — midpoints use deterministic predictions)
    spread_6m  = float(np.percentile(mc_6m,  90) - np.percentile(mc_6m,  10))
    spread_12m = float(np.percentile(mc_12m, 90) - np.percentile(mc_12m, 10))
    # Floor: same calibration as predict_long_term.py — prevents the MC
    # ensemble from emitting a zero-width band when the model is confident on
    # a stable stock. Without this, downstream spread_1w = spread_6m * (5/126)
    # also collapses, producing the predicted_range_1w = [price, price] bug.
    spread_6m  = max(spread_6m,  current_price * 0.04)
    spread_12m = max(spread_12m, current_price * 0.08)
    spread_18m = spread_12m * 1.5

    # 18m extrapolation beyond 12m anchor
    p18m_est = predicted_price_1y + (predicted_price_1y - predicted_price_6m)

    trajectory = []
    last_date_str = str(df['Date'].iloc[-1]) if 'Date' in df.columns else datetime.today().strftime('%Y-%m-%d')
    last_date = datetime.strptime(last_date_str[:10], '%Y-%m-%d')

    # See predict_weighted_analysis.py for the wiggle rationale. Same SEED so
    # the path is deterministic and reproducible across reruns.
    traj_rng = np.random.default_rng(SEED)

    def _wiggle(t: float, spread: float) -> float:
        if t <= 0.0 or t >= 1.0:
            return 0.0
        return float(traj_rng.standard_normal()) * spread * 0.10 * np.sin(np.pi * t)

    for idx, td in enumerate(WAYPOINTS):
        if td == T5:
            # 1-week: exact MLP T+5 output
            mid    = predicted_price_1w
            spread = spread_6m * (T5 / T6)
        elif td <= T6:
            # 1w → 6m segment: interpolate toward predicted_price_6m
            t      = (td - T5) / (T6 - T5)
            mid    = predicted_price_1w + (predicted_price_6m - predicted_price_1w) * t
            spread = spread_6m * (td / T6)
            mid   += _wiggle(t, spread)
        elif td <= T12:
            # 6m → 12m segment: interpolate toward predicted_price_1y
            t      = (td - T6) / (T12 - T6)
            mid    = predicted_price_6m + (predicted_price_1y - predicted_price_6m) * t
            spread = spread_6m + (spread_12m - spread_6m) * t
            mid   += _wiggle(t, spread)
        else:
            # 12m → 18m: linear extrapolation
            t      = (td - T12) / (T18 - T12)
            mid    = predicted_price_1y + (p18m_est - predicted_price_1y) * t
            spread = spread_12m + (spread_18m - spread_12m) * t
            mid   += _wiggle(t, spread)

        # Calendar month label
        waypoint_date = last_date + timedelta(days=int(td * 365.25 / 252))
        month_label   = waypoint_date.strftime('%b %Y')

        trajectory.append({
            "month":           month_label,
            "predicted_price": round(mid, 2),
            "lower_bound":     round(mid - spread / 2, 2),
            "upper_bound":     round(mid + spread / 2, 2),
        })

    # ---- Accuracy metrics ----
    # mae and rmse are computed from holdout residuals at line 1455/1456.
    # The historical `np.sqrt(cv_mae ** 2)` was a no-op (sqrt of a square == the
    # absolute value), so before this fix all three keys reported the same number.
    rmse    = cv_rmse
    mae_val = cv_mae

    # ---- Confidence scores ----
    imputed = data_quality.get('imputedFields', [])
    analyst_count = int(safe(stock_metrics.get('analystOpinionCount'), 0))
    history_years = safe(data_quality.get('historyYears'), 2.0)

    # Debug logging for confidence score inputs
    print(f"[DEBUG] Confidence score inputs for {ticker}:", file=sys.stderr)
    print(f"  cv_mape: {cv_mape:.2f}%", file=sys.stderr)
    print(f"  history_years: {history_years}", file=sys.stderr)
    print(f"  imputed_fields ({len(imputed)}): {imputed}", file=sys.stderr)
    print(f"  analyst_count: {analyst_count}", file=sys.stderr)

    cs6m = confidence_score(cv_mape, history_years, imputed, analyst_count)
    cs1y = max(0, cs6m - 15)

    # ---- High-uncertainty flag ----
    high_uncertainty = abs(predicted_price_1y - current_price) / (current_price + 1e-9) > 0.60

    # ---- 6m trajectory bounds (for backward compat predicted_change_range) ----
    traj_6m = trajectory[6]   # index 6 = waypoint 126 (6 months), shifted +1 by t+5 prepend
    prange_low  = round(traj_6m['lower_bound'] - current_price, 2)
    prange_high = round(traj_6m['upper_bound']  - current_price, 2)

    # 1w spread (already set above; compute here for the range field)
    spread_1w = spread_6m * (T5 / T6)

    # ---- 1m trajectory point (index 1 = waypoint t+21 ≈ 1 month), shifted +1 by t+5 prepend ----
    traj_1m = trajectory[1]

    predicted_price_1m = traj_1m['predicted_price']
    pct_1m = round((predicted_price_1m - current_price) / (current_price + 1e-9) * 100, 2)

    # Earnings-window dampening: within 14 days of earnings the 1m window is the
    # most dangerous (binary event risk), so confidence should be LOWER than cs6m,
    # not higher. Outside that window the standard tighter-horizon boost applies.
    _next_earnings_str = stock_metrics.get('nextEarningsDate')
    _days_to_earnings = 999
    if _next_earnings_str:
        try:
            _days_to_earnings = (datetime.fromisoformat(str(_next_earnings_str)).date()
                                 - datetime.today().date()).days
        except Exception:
            pass
    if _days_to_earnings <= 14:
        cs1m = max(0, cs6m - 10)   # near earnings: more uncertain, not less
    else:
        cs1m = min(100, cs6m + 10)  # standard: tighter horizon = slight confidence boost

    # ---- 1w metrics ----
    pct_1w = round((predicted_price_1w - current_price) / (current_price + 1e-9) * 100, 2)
    cs1w = min(100, cs1m + 3)  # 1w is tighter than 1m but less certain than 1d was

    pct_6m  = round((predicted_price_6m  - current_price) / (current_price + 1e-9) * 100, 2)
    pct_12m = round((predicted_price_1y  - current_price) / (current_price + 1e-9) * 100, 2)

    result = {
        "ticker":                str(ticker).upper().strip(),
        "regularMarketPrice":    round(current_price, 2),
        # 1-week short-term (direct T+5 MLP output)
        "predicted_price_1w":      round(predicted_price_1w, 2),
        "predicted_change_pct_1w": pct_1w,
        "confidence_score_1w":     cs1w,
        "predicted_range_1w":      [round(predicted_price_1w - spread_1w / 2, 2), round(predicted_price_1w + spread_1w / 2, 2)],
        # Dual-horizon
        "predicted_price_6m":   round(predicted_price_6m, 2),
        "predicted_price_1y":   round(predicted_price_1y, 2),
        "predicted_change_pct_6m":  pct_6m,
        "predicted_change_pct_1y":  pct_12m,
        "confidence_score_6m":  cs6m,
        "confidence_score_1y":  cs1y,
        "predicted_price_1m":      round(predicted_price_1m, 2),
        "predicted_change_pct_1m": pct_1m,
        "confidence_score_1m":     cs1m,
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
        # Regime info (Phase 2-3)
        "regime_info": regime_info,
        # Legacy metric analysis
        "metric_analysis": m_analysis,
        # Phase 4 Observability
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

        # Clamp out-of-bounds predictions before anything downstream sees
        # them (recorder, GPS, dashboard). Run on cached results too in
        # case an older cached entry has wild values from a prior bug.
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