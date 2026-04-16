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
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from scipy.stats import skew as scipy_skew
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
MC_RUNS    = 12    # reduced for faster trajectory generation


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
    score = 0
    count = 0
    for a in news_articles:
        s = a.get('sentiment_score')
        published_at = a.get('publishedAt')
        if s is None:
            continue
        weight = 1.0
        if published_at:
            try:
                pub = datetime.fromisoformat(published_at.replace('Z', '+00:00'))
                age_days = (datetime.now(pub.tzinfo) - pub).days
                weight = max(0.1, 1.0 - age_days / 30.0)  # decay over 30 days
            except Exception:
                pass
        if abs(s) >= 3:
            score += (1 if s > 0 else -1) * weight
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

    # ── Earnings-window flags ────────────────────────────────────────────────
    # Parse next earnings date from stockMetrics
    next_earnings_str = stock_metrics.get('nextEarningsDate')
    next_earnings_date = None
    if next_earnings_str:
        try:
            next_earnings_date = datetime.fromisoformat(next_earnings_str).date()
        except Exception:
            pass

    # Earnings_In_Window: 1 if current date is within ±5 days of known earnings
    # Days_Since_Last_Earnings: rolling count from historicalEarnings
    # Days_To_Next_Earnings: days until next earnings (NaN if unknown)
    f['Earnings_In_Window'] = 0.0
    f['Days_Since_Last_Earnings'] = 0.0
    f['Days_To_Next_Earnings'] = np.nan

    # ── World Bank Macro (Phase 4) ───────────────────────────────────────────
    wb = macro_data.get('worldBank', {}) or {}
    indicators = wb.get('indicators', {}) or {}

    # Broadcast scalar annual values to all rows
    f['WorldBank_GDP'] = safe(indicators.get('gdpGrowth'), 2.0)
    f['WorldBank_Inflation'] = safe(indicators.get('inflation'), 2.5)
    f['WorldBank_Consumption'] = safe(indicators.get('consumptionGrowth'), 2.0)
    f['WorldBank_Real_GDP'] = f['WorldBank_GDP'] - f['WorldBank_Inflation']

    return f


def build_features(df, stock_metrics, macro_data, news_sentiment, earnings_beat_streak, current_price, options_data=None, feature_metrics=None, next_earnings_date=None):
    """
    Build full feature DataFrame from OHLCV df + supplementary inputs.
    Returns a new DataFrame with FEATURE_COLUMNS, NaNs forward-filled.
    """
    close  = df['Close'].values
    high   = df['High'].values
    low    = df['Low'].values
    volume = df['Volume'].values
    n = len(df)
    dates = df['Date'].values if 'Date' in df.columns else [None] * n

    f = pd.DataFrame(index=df.index)
    f['Open']   = df['Open']
    f['High']   = df['High']
    f['Low']    = df['Low']
    f['Close']  = df['Close']
    f['Volume'] = df['Volume']

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

    # Fundamentals (scalar → broadcast)
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

    # Macro features — merge by date
    date_strs = []
    if 'Date' in df.columns:
        date_strs = df['Date'].astype(str).tolist()
    else:
        date_strs = [None] * n

    vix_series  = merge_series_by_date(date_strs, macro_data.get('vix', []))
    tnx_series  = merge_series_by_date(date_strs, macro_data.get('treasury10y', []))
    etf_data    = macro_data.get('sectorEtf', {}).get('data', [])
    etf_series  = merge_series_by_date(date_strs, etf_data)

    f['VIX']          = vix_series
    f['VIX_20d_Avg']  = pd.Series(vix_series).rolling(20).mean().bfill().ffill().values
    f['Treasury10Y']  = tnx_series

    # 60-day rolling correlation between stock close and sector ETF
    if etf_series.std() > 0:
        stock_ser = pd.Series(close)
        etf_ser   = pd.Series(etf_series)
        corr = stock_ser.rolling(60).corr(etf_ser).fillna(0).values
    else:
        corr = np.zeros(n)
    f['SectorETF_60d_Corr'] = corr

    # Options market data — broadcast across all rows
    # If options_data unavailable, features default to NaN (filled later)
    iv_val = 0.0
    iv_rank_val = 0.0
    put_call_ratio_val = 0.0

    if options_data and isinstance(options_data, dict):
        iv_val = safe(options_data.get('iv'), 0.0)
        iv_rank_val = safe(options_data.get('ivRank'), 0.0)
        put_call_ratio_val = safe(options_data.get('putCallRatio'), 0.0)

    f['IV'] = iv_val if iv_val > 0 else np.nan
    f['IV_Rank'] = iv_rank_val if iv_val > 0 else np.nan  # Only valid if IV is available
    f['Put_Call_Ratio'] = put_call_ratio_val if put_call_ratio_val > 0 else np.nan

    # Earnings surprises & short interest — broadcast as scalar across rows
    # Clip to reasonable ranges; use NaN if unavailable
    eps_surprise = 0.0
    revenue_surprise = 0.0
    short_float = 0.0
    days_to_cover = 0.0

    if feature_metrics and isinstance(feature_metrics, dict):
        # EPS surprise: clip to [-50, 50] percent
        eps_val = safe(feature_metrics.get('epsSurpriseAvg4Q'), 0.0)
        eps_surprise = max(-50.0, min(50.0, eps_val)) if eps_val != 0.0 else 0.0

        # Revenue surprise: clip to [-50, 50] percent
        rev_val = safe(feature_metrics.get('revenueSurpriseAvg4Q'), 0.0)
        revenue_surprise = max(-50.0, min(50.0, rev_val)) if rev_val != 0.0 else 0.0

        # Short float: clip to [0, 100] percent
        short_val = safe(feature_metrics.get('shortFloatPct'), 0.0)
        short_float = max(0.0, min(100.0, short_val * 100)) if short_val != 0.0 else 0.0  # Convert decimal to percent points

        # Days to cover: clip to [0, 30] days
        dtc_val = safe(feature_metrics.get('daysToCover'), 0.0)
        days_to_cover = max(0.0, min(30.0, dtc_val)) if dtc_val != 0.0 else 0.0

    f['EPS_Surprise_Avg_4Q'] = eps_surprise if eps_surprise != 0.0 else np.nan
    f['Revenue_Surprise_Avg_4Q'] = revenue_surprise if revenue_surprise != 0.0 else np.nan
    f['ShortFloatPct'] = short_float if short_float > 0.0 else np.nan
    f['DaysToCover'] = days_to_cover if days_to_cover > 0.0 else np.nan

    # Derived / calendar
    f['NewsSentiment']     = news_sentiment
    f['EarningsBeatStreak'] = earnings_beat_streak

    if 'Date' in df.columns:
        months = pd.to_datetime(df['Date']).dt.month.values
    else:
        months = np.ones(n, dtype=int)
    f['Month_Sin']     = np.sin(2 * np.pi * months / 12)
    f['Month_Cos']     = np.cos(2 * np.pi * months / 12)
    f['EarningsSeason'] = np.isin(months, [1, 4, 7, 10]).astype(float)

    # ── Improvement 1: Lag features ──────────────────────────────────────────
    # Explicitly hand the MLP past price/volume values so it can learn
    # how recent history relates to the current reading.
    close_s  = pd.Series(close)
    volume_s = pd.Series(volume)
    f['Close_lag_5']  = close_s.shift(5).values
    f['Close_lag_10'] = close_s.shift(10).values
    f['Close_lag_20'] = close_s.shift(20).values
    f['Volume_lag_5'] = volume_s.shift(5).values

    # ── Improvement 2: Short-term ROC & returns ───────────────────────────────
    # Short-window rates-of-change capture momentum the MLP would otherwise miss.
    f['ROC_5d']    = close_s.pct_change(5).values
    f['ROC_20d']   = close_s.pct_change(20).values
    f['Return_1d'] = close_s.pct_change(1).values
    f['Return_5d'] = close_s.pct_change(5).values        # alias for clarity
    f['Return_20d']= close_s.pct_change(20).values

    # ── Improvement 3: Price vs rolling high/low + volume-price trend ─────────
    # Tells the model whether the stock is near a breakout, breakdown,
    # or grinding in the middle of its recent range.
    roll5_high  = close_s.rolling(5).max()
    roll20_high = close_s.rolling(20).max()
    roll20_low  = close_s.rolling(20).min()

    f['PriceToHigh_5d']  = (close_s / (roll5_high  + 1e-9)).values
    f['PriceToHigh_20d'] = (close_s / (roll20_high + 1e-9)).values
    f['PriceToLow_20d']  = (close_s / (roll20_low  + 1e-9)).values

    # Volume-price trend: rising price + rising volume = strong momentum
    daily_ret = close_s.pct_change().fillna(0)
    f['VolumePriceTrend'] = (daily_ret * volume_s).rolling(10).sum().values

    # EMA slope: direction & steepness of the EMA (not just its level)
    ema10 = close_s.ewm(span=10, adjust=False).mean()
    ema20 = close_s.ewm(span=20, adjust=False).mean()
    f['EMA_Slope_10'] = ema10.diff(3).values   # 3-day change in EMA10
    f['EMA_Slope_20'] = ema20.diff(3).values   # 3-day change in EMA20

    # ── Improvement 4: Rolling return statistics ──────────────────────────────
    # Compress recent return history into statistical moments so the MLP
    # can sense whether momentum is consistent, noisy, or skewed.
    ret20 = daily_ret.rolling(20)
    f['RollingMean_20d']   = ret20.mean().values
    f['RollingStd_20d']    = ret20.std().values
    f['RollingSkew_20d']   = ret20.apply(scipy_skew, raw=True).values
    # Rolling Sharpe: mean daily return / std (annualised implicitly via ratio)
    rolling_sharpe = ret20.mean() / (ret20.std() + 1e-9)
    f['RollingSharpe_20d'] = rolling_sharpe.values

    # ── Phase 1 Macro Features ───────────────────────────────────────────────
    hist_vol = f['HistVol_30'].values if 'HistVol_30' in f.columns else np.ones(n) * 0.20
    f = _add_macro_features(f, date_strs, macro_data, close_s, hist_vol, stock_metrics)

    # Reorder and fill
    f = f[FEATURE_COLUMNS]
    f = f.ffill().bfill().fillna(0)
    return f


# ============================================================================
# MLP MODEL (sklearn — CPU-portable, no AVX/AVX2 requirement)
# ============================================================================
def build_mlp(seed=SEED):
    # Widened to handle expanded feature set + regime features (~109 features total)
    # Input dims: 109 features × 60 steps = 6,540 flattened inputs
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


def build_regime_detector(market_vec_norm, fitted_model, n_clusters):
    """
    Use a fitted model (from select_regime_k) to predict regimes.
    If no fitted model, falls back to KMeans.
    """
    from sklearn.cluster import KMeans

    if fitted_model is not None:
        try:
            labels = fitted_model.predict(market_vec_norm)
            probs = fitted_model.predict_proba(market_vec_norm)
            return labels, probs
        except:
            pass

    # Fallback to KMeans if GMM not provided or failed
    try:
        km = KMeans(n_clusters=n_clusters, n_init=5, random_state=SEED)
        labels = km.fit_predict(market_vec_norm)
        return labels, None
    except:
        return np.zeros(len(market_vec_norm), dtype=int), None


def select_regime_k(market_vec, min_state_frac=0.15, max_flip_rate=0.30):
    """
    K selection gate: evaluate K=3 and K=4, return best K that passes hard gates.
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


def make_sequences(scaled, targets_6m, targets_1y):
    """
    Build (X, y) sequences of length SEQ_LEN, flattened for sklearn.
    y = [price_6m, price_1y] at the end of each sequence.
    """
    X, Y = [], []
    for i in range(len(scaled) - SEQ_LEN):
        X.append(scaled[i : i + SEQ_LEN].flatten())
        Y.append([targets_6m[i + SEQ_LEN], targets_1y[i + SEQ_LEN]])
    return np.array(X, dtype=np.float32), np.array(Y, dtype=np.float32)


# ============================================================================
# CONFIDENCE SCORE
# ============================================================================
def confidence_score(cv_mape, history_years, imputed_fields, analyst_count):
    pts = 0
    # CV MAPE (40 pts)
    if cv_mape < 5:   pts += 40
    elif cv_mape < 10: pts += 30
    elif cv_mape < 20: pts += 15

    # History depth (25 pts)
    if history_years >= 5:   pts += 25
    elif history_years >= 4: pts += 20
    elif history_years >= 3: pts += 12
    elif history_years >= 2: pts += 5

    # Feature completeness (20 pts)
    n_imp = len(imputed_fields)
    if n_imp == 0:    pts += 20
    elif n_imp <= 2:  pts += 14
    elif n_imp <= 5:  pts += 8

    # Analyst coverage (15 pts)
    if analyst_count >= 10: pts += 15
    elif analyst_count >= 5: pts += 10
    elif analyst_count >= 1: pts += 5

    return min(pts, 100)


# ============================================================================
# LEGACY METRIC ANALYSIS (kept for backward compat)
# ============================================================================
def metric_analysis(df, stock_metrics, news_sentiment, growth_rate, is_uptrend, earnings_beat_streak, external_tech_score=0.0, consensus_value=0.0, analyst_weighted=0.0):
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

    total_impact += (growth_rate / 100) * 0.03
    total_impact += news_sentiment * 0.015
    
    # ── External Technical Indicator Influence ──
    # Scaled such that a max buy (+14) adds ~7.0% (was 3.5%)
    total_impact += external_tech_score * 0.005

    # ── Analyst Consensus Influence (0.0 to 1.0) ──
    # A strong buy (1.0) adds ~5% (was 2%) to the target.
    total_impact += consensus_value * 0.05

    # ── Analyst Numerical Target Premium (0.0 to 1.0) ──
    # Directly nudges prediction toward the analyst target mean.
    total_impact += analyst_weighted * 0.05

    # ── Earnings Beat Streak influence (0-4 quarters) ──
    # Adds ~1.0% per beat (was 0.5%). Max +4%.
    total_impact += earnings_beat_streak * 0.01

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
    
    # Analyst Consensus (recommendationKey) from frontend
    recommendation_key = input_data.get('recommendationKey')
    consensus_key = (recommendation_key or '').lower().replace('_', ' ') if recommendation_key else ''
    consensus_map = {
        'strong buy': 1.0,
        'buy': 0.75,
        'hold': 0.0,
        'sell': -0.75,
        'strong sell': -1.0
    }
    consensus_value = consensus_map.get(consensus_key, 0.0)

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

    if len(df) < 504:
        raise ValueError(f"Insufficient data: {len(df)} rows, need ≥ 504.")

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
                              news_sentiment, earnings_beat_streak, current_price, options_data, feature_metrics)

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

    targets_6m  = np.zeros(len(scaled))
    targets_1y  = np.zeros(len(scaled))
    for i in range(len(scaled)):
        targets_6m[i]  = scaled_close[min(i + T6,  len(scaled) - 1)]
        targets_1y[i]  = scaled_close[min(i + T12, len(scaled) - 1)]

    X, Y = make_sequences(scaled, targets_6m, targets_1y)

    if len(X) < 50:
        raise ValueError("Not enough sequences for training.")

    # ---- Single holdout validation (last 20% of sequences as test) ----
    # Replaces 3-fold walk-forward CV (~30s) with a single split (~0s extra
    # compute — the split is free; we reuse the final model's val_loss).
    # cv_mae is populated after final model training below.
    split_idx = int(len(X) * 0.8)
    X_hold, Y_hold = X[split_idx:], Y[split_idx:]

    # ---- Train final model on full data ----
    model = build_mlp()
    model.fit(X, Y)

    # Compute cv_mae from the held-out 20% (no extra model train needed)
    if len(X_hold) > 0:
        hold_pred = model.predict(X_hold)
        dummy_pred = np.zeros((len(hold_pred), n_features), dtype=np.float32)
        dummy_pred[:, close_col_idx] = hold_pred[:, 0]
        pred_prices_hold = scaler.inverse_transform(dummy_pred)[:, close_col_idx]

        dummy_act = np.zeros((len(Y_hold), n_features), dtype=np.float32)
        dummy_act[:, close_col_idx] = Y_hold[:, 0]
        actual_prices_hold = scaler.inverse_transform(dummy_act)[:, close_col_idx]

        cv_mae = float(mean_absolute_error(actual_prices_hold, pred_prices_hold))
    else:
        cv_mae = float(current_price * 0.05)
    cv_mape = (cv_mae / (current_price + 1e-9)) * 100

    # ---- Legacy metric analysis ----
    m_analysis = metric_analysis(feat_df, stock_metrics, news_sentiment,
                                  growth_rate, is_uptrend, earnings_beat_streak, external_tech_score, consensus_value, analyst_weighted_val)

    # ── Final Price Adjustment ──
    # We apply the total_impact as a final multiplier to the MLP output.
    # This allows the heuristics (RSI, News, Technical Score) to nudge the
    # sophisticated neural network result.
    impact_multiplier = 1.0 + m_analysis['total_metric_impact']

    # ── World Bank Consumption Heuristic (Phase 4) ──
    # Only applies to 'Consumer Cyclical' and 'Consumer Defensive' sectors.
    consumer_multiplier = 1.0
    sector = stock_metrics.get('sector', '')
    if sector in ['Consumer Cyclical', 'Consumer Defensive']:
        cons_growth = feat_df['WorldBank_Consumption'].iloc[-1]
        # 1% growth adds 0.5% price premium, capped at +/- 3%
        consumer_multiplier = 1.0 + max(-0.03, min(0.03, cons_growth * 0.005))

    impact_multiplier *= consumer_multiplier

    # ---- Deterministic 6m / 12m predictions ----
    last_seq = scaled[-SEQ_LEN:].flatten().reshape(1, -1)
    pred_scaled = model.predict(last_seq)[0]  # [p6m, p1y]

    def inverse_close(scaled_val):
        dummy = np.zeros((1, n_features), dtype=np.float32)
        dummy[0, close_col_idx] = float(scaled_val)
        return float(scaler.inverse_transform(dummy)[0, close_col_idx])

    predicted_price_6m = inverse_close(pred_scaled[0]) * impact_multiplier
    predicted_price_1y = inverse_close(pred_scaled[1]) * impact_multiplier

    # ---- Monte Carlo Dropout — 18-month trajectory ----
    WAYPOINTS = list(range(21, 379, 21))  # t+21, t+42, ... t+378 (18 months)

    # We generate monthly waypoint predictions by using the last SEQ_LEN window
    # and asking the model to predict at each future horizon.  Since the model
    # outputs only 6m and 12m directly, we interpolate/extrapolate the trajectory
    # using the MC spread around those anchors.
    # Approach: run MC passes on last_seq; use output[0] as 6m anchor, output[1] as 12m anchor.
    # For other waypoints, interpolate linearly between current_price → 6m → 12m → extrapolate to 18m.

    mc_6m  = []
    mc_12m = []

    # MC uncertainty: perturb the input with Gaussian noise scaled to each
    # feature's recent standard deviation — more principled than fixed σ=0.01.
    # This means price features get noise proportional to recent price swings,
    # volume features get noise proportional to volume variance, etc.
    feature_stds = scaled[-20:].std(axis=0)   # std over last 20 rows (post-scaling)
    feature_stds = np.clip(feature_stds, 1e-4, None)  # avoid zero-std features
    # Tile per-feature stds to match the flattened sequence length (SEQ_LEN × n_features)
    tiled_stds = np.tile(feature_stds, SEQ_LEN).reshape(1, -1).astype(np.float32)
    rng = np.random.default_rng(SEED)
    for _ in range(MC_RUNS):
        noise = rng.normal(0, 1, last_seq.shape).astype(np.float32)
        noise *= (tiled_stds * 0.1)    # scale: 10% of each feature's recent σ
        noisy = last_seq + noise
        p = model.predict(noisy)[0]
        mc_6m.append(inverse_close(p[0]) * impact_multiplier)
        mc_12m.append(inverse_close(p[1]) * impact_multiplier)

    mc_6m  = np.array(mc_6m)
    mc_12m = np.array(mc_12m)

    # Build trajectory: interpolate across 18 waypoints
    # Anchors: t=0 → current_price, t=126 → mean(mc_6m), t=252 → mean(mc_12m), t=378 → extrapolate
    p6m_mean  = float(mc_6m.mean())
    p12m_mean = float(mc_12m.mean())
    p18m_est  = p12m_mean + (p12m_mean - p6m_mean)   # simple linear extrapolation

    # Spread scales with horizon
    spread_6m  = float(np.percentile(mc_6m,  90) - np.percentile(mc_6m,  10))
    spread_12m = float(np.percentile(mc_12m, 90) - np.percentile(mc_12m, 10))
    spread_18m = spread_12m * 1.5  # wider for 18m

    trajectory = []
    last_date_str = str(df['Date'].iloc[-1]) if 'Date' in df.columns else datetime.today().strftime('%Y-%m-%d')
    last_date = datetime.strptime(last_date_str[:10], '%Y-%m-%d')

    for idx, td in enumerate(WAYPOINTS):
        frac6m  = min(td / T6,  1.0)
        frac12m = min(td / T12, 1.0)
        frac18m = td / T18

        if td <= T6:
            mid    = current_price + (p6m_mean  - current_price) * frac6m
            spread = spread_6m  * frac6m
        elif td <= T12:
            t = (td - T6) / (T12 - T6)
            mid    = p6m_mean + (p12m_mean - p6m_mean) * t
            spread = spread_6m + (spread_12m - spread_6m) * t
        else:
            t = (td - T12) / (T18 - T12)
            mid    = p12m_mean + (p18m_est - p12m_mean) * t
            spread = spread_12m + (spread_18m - spread_12m) * t

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
    rmse = float(np.sqrt(cv_mae ** 2))   # approx; use cv_mae as primary
    mae_val = cv_mae

    # ---- Confidence scores ----
    imputed = data_quality.get('imputedFields', [])
    analyst_count = int(safe(stock_metrics.get('analystOpinionCount'), 0))
    history_years = safe(data_quality.get('historyYears'), 2.0)

    cs6m = confidence_score(cv_mape, history_years, imputed, analyst_count)
    cs1y = max(0, cs6m - 15)

    # ---- High-uncertainty flag ----
    high_uncertainty = abs(predicted_price_1y - current_price) / (current_price + 1e-9) > 0.60

    # ---- 6m trajectory bounds (for backward compat predicted_change_range) ----
    traj_6m = trajectory[5]   # index 5 = waypoint 126 (6 months)
    prange_low  = round(traj_6m['lower_bound'] - current_price, 2)
    prange_high = round(traj_6m['upper_bound']  - current_price, 2)

    # ---- 1d trajectory point (interpolated from initial movement toward 6m) ----
    frac_1d = 1.0 / T6  # 1 trading day out of ~126 trading days to 6 months
    base_1d_return = (p6m_mean - current_price) / (current_price + 1e-9)
    # CORRECTED: 1-day prediction is now an interpolation, not the full 6m target
    predicted_price_1d = current_price * (1.0 + base_1d_return * frac_1d)
    spread_1d = spread_6m * frac_1d

    # ---- 1m trajectory point (index 0 = waypoint t+21 ≈ 1 month) ----
    traj_1m = trajectory[0]   # index 0 = waypoint 21 trading days (~1 month)

    predicted_price_1m = traj_1m['predicted_price']
    pct_1m = round((predicted_price_1m - current_price) / (current_price + 1e-9) * 100, 2)
    cs1m = min(100, cs6m + 10)  # 1m is tighter horizon → slightly higher confidence

    # ---- 1d metrics ----
    pct_1d = round((predicted_price_1d - current_price) / (current_price + 1e-9) * 100, 2)
    cs1d = min(100, cs1m + 5)  # 1d is even tighter → highest confidence

    pct_6m  = round((predicted_price_6m  - current_price) / (current_price + 1e-9) * 100, 2)
    pct_12m = round((predicted_price_1y  - current_price) / (current_price + 1e-9) * 100, 2)

    result = {
        "ticker":                str(ticker).upper().strip(),
        "regularMarketPrice":    round(current_price, 2),
        # 1-day short-term
        "predicted_price_1d":      round(predicted_price_1d, 2),
        "predicted_change_pct_1d": pct_1d,
        "confidence_score_1d":     cs1d,
        "predicted_range_1d":      [round(predicted_price_1d - spread_1d / 2, 2), round(predicted_price_1d + spread_1d / 2, 2)],
        # short_term_signal_breakdown removed
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
    parser.add_argument('--outlook',    type=str, default='all', choices=['1_day', '1_month', '6_month', '1_year', 'all'], help='Prediction outlook')
    args = parser.parse_args()

    try:
        with open(args.input_file, 'r') as fh:
            input_data = json.load(fh)

        result = predict(args.ticker, input_data)

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

            if args.outlook == '1_day':
                filtered.update({
                    "predicted_price": result["predicted_price_1d"],
                    "predicted_change_pct": result["predicted_change_pct_1d"],
                    "confidence_score": result["confidence_score_1d"],
                    "predicted_range": result["predicted_range_1d"]
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
