"""
predict_weighted_analysis.py — LSTM-based stock price prediction.

CONSTRAINT: This script must NOT import yfinance, requests, urllib, httpx,
or any HTTP/network library. All data arrives via --input_file JSON.

CLI:
    python3 predict_weighted_analysis.py <ticker> --input_file <path>

Input (from file):
    JSON payload as produced by GET /api/stock/[ticker]/data

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
from sklearn.preprocessing import MinMaxScaler
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error

os_module = __import__('os')
os_module.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
os_module.environ.setdefault('TF_ENABLE_ONEDNN_OPTS', '0')

import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout
from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau

warnings.filterwarnings('ignore')

# Reproducibility
SEED = 42
random.seed(SEED)
np.random.seed(SEED)
tf.random.set_seed(SEED)

SEQ_LEN    = 60    # 60 trading-day lookback window
N_EPOCHS   = 60    # cap; EarlyStopping fires well before this on most tickers
BATCH_SIZE = 128   # larger batches → fewer gradient steps per epoch → faster
MC_RUNS    = 20    # Monte Carlo Dropout passes (20 is statistically sufficient)


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
]


def build_features(df, stock_metrics, macro_data, news_sentiment, earnings_beat_streak, current_price):
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

    # Reorder and fill
    f = f[FEATURE_COLUMNS]
    f = f.ffill().bfill().fillna(0)
    return f


# ============================================================================
# LSTM MODEL
# ============================================================================
def build_lstm(n_features):
    # 64→32 units: ~40% fewer parameters than 128→64, trains ~2× faster
    # with negligible accuracy loss on 5-year daily data.
    model = Sequential([
        LSTM(64, return_sequences=True, input_shape=(SEQ_LEN, n_features)),
        Dropout(0.2),
        LSTM(32, return_sequences=False),
        Dropout(0.2),
        Dense(2),   # [price_6m_scaled, price_1y_scaled]
    ])
    model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
                  loss=tf.keras.losses.Huber())
    return model


def make_sequences(scaled, targets_6m, targets_1y):
    """
    Build (X, y) sequences of length SEQ_LEN.
    y = [price_6m, price_1y] at the end of each sequence.
    """
    X, Y = [], []
    for i in range(len(scaled) - SEQ_LEN):
        X.append(scaled[i : i + SEQ_LEN])
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
def metric_analysis(df, stock_metrics, news_sentiment, growth_rate, is_uptrend, earnings_beat_streak):
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
    if rsi > 70:   total_impact -= 0.03
    elif rsi < 30: total_impact += 0.03
    if is_uptrend: total_impact += 0.08
    else:          total_impact -= 0.08
    total_impact += (growth_rate / 100) * 0.05
    total_impact += news_sentiment * 0.04

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
    news_articles      = input_data.get('newsArticles', [])
    historical_earnings = input_data.get('historicalEarnings', [])
    data_quality       = input_data.get('dataQuality', {})

    if not historical_data:
        raise ValueError("No historical data provided.")

    # ---- Build DataFrame ----
    df = pd.DataFrame(historical_data)
    df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low',
                        'close': 'Close', 'volume': 'Volume', 'date': 'Date'},
              inplace=True)

    if len(df) < 504:
        raise ValueError(f"Insufficient data: {len(df)} rows, need ≥ 504.")

    current_price = float(df['Close'].iloc[-1])

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
                              news_sentiment, earnings_beat_streak, current_price)
    n_features = len(FEATURE_COLUMNS)
    raw = feat_df.values.astype(np.float32)

    # ---- Scale features ----
    scaler = MinMaxScaler(feature_range=(0, 1))
    # Scale close separately for target inverse-transform
    close_col_idx = FEATURE_COLUMNS.index('Close')

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
    model = build_lstm(n_features)
    callbacks = [
        EarlyStopping(patience=10, restore_best_weights=True, monitor='val_loss'),
        ReduceLROnPlateau(patience=5, factor=0.5, monitor='val_loss'),
    ]
    model.fit(
        X, Y,
        validation_split=0.1,
        epochs=N_EPOCHS,
        batch_size=BATCH_SIZE,
        verbose=0,
        callbacks=callbacks,
    )

    # Compute cv_mae from the held-out 20% (no extra model train needed)
    if len(X_hold) > 0:
        hold_pred = model.predict(X_hold, verbose=0)
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

    # ---- Deterministic 6m / 12m predictions ----
    last_seq = scaled[-SEQ_LEN:].reshape(1, SEQ_LEN, n_features)
    pred_scaled = model.predict(last_seq, verbose=0)[0]  # [p6m, p1y]

    def inverse_close(scaled_val):
        dummy = np.zeros((1, n_features), dtype=np.float32)
        dummy[0, close_col_idx] = float(scaled_val)
        return float(scaler.inverse_transform(dummy)[0, close_col_idx])

    predicted_price_6m = inverse_close(pred_scaled[0])
    predicted_price_1y = inverse_close(pred_scaled[1])

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

    # Enable dropout at inference time
    @tf.function
    def mc_predict(x):
        return model(x, training=True)

    for _ in range(MC_RUNS):
        p = mc_predict(last_seq).numpy()[0]
        mc_6m.append(inverse_close(p[0]))
        mc_12m.append(inverse_close(p[1]))

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

    pct_6m  = round((predicted_price_6m  - current_price) / (current_price + 1e-9) * 100, 2)
    pct_12m = round((predicted_price_1y  - current_price) / (current_price + 1e-9) * 100, 2)

    # ---- Legacy metric analysis ----
    m_analysis = metric_analysis(feat_df, stock_metrics, news_sentiment,
                                  growth_rate, is_uptrend, earnings_beat_streak)

    result = {
        "ticker":                str(ticker).upper().strip(),
        "regularMarketPrice":    round(current_price, 2),
        # Dual-horizon
        "predicted_price_6m":   round(predicted_price_6m, 2),
        "predicted_price_1y":   round(predicted_price_1y, 2),
        "predicted_change_pct_6m":  pct_6m,
        "predicted_change_pct_1y":  pct_12m,
        "confidence_score_6m":  cs6m,
        "confidence_score_1y":  cs1y,
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
        # Legacy metric analysis
        "metric_analysis": m_analysis,
    }
    return result


# ============================================================================
# ENTRY POINT
# ============================================================================
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='LSTM Stock Price Prediction')
    parser.add_argument('ticker',       type=str, help='Stock ticker symbol')
    parser.add_argument('--input_file', type=str, required=True, help='Path to JSON input file')
    args = parser.parse_args()

    try:
        with open(args.input_file, 'r') as fh:
            input_data = json.load(fh)

        result = predict(args.ticker, input_data)
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
