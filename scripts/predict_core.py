"""
predict_core.py — shared core for the v3-split prediction pipeline.

Holds everything that both the short-term (1w/1m) and long-term (6m/1y)
models need: feature engineering, regime detection, sequence builder,
confidence scoring, sanitization. Orchestration (which model to call,
how to merge results, CLI handling) lives in predict_weighted_analysis.py.

CONSTRAINT (inherited): no yfinance/requests/urllib/httpx imports.
All inputs arrive via JSON.
"""

import sys
import json
import warnings
import random
import math
import hashlib
import os
import pickle

# ── CPU Throttling ──
# Must run before importing numpy/sklearn, hence at module top regardless of
# which file is loaded first.
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['VECLIB_MAXIMUM_THREADS'] = '1'
os.environ['NUMEXPR_NUM_THREADS'] = '1'

# Lower process priority so the OS favors web server etc.
try:
    os.nice(15)
except Exception:
    pass

from datetime import datetime, timedelta, date

import numpy as np
import pandas as pd
from sklearn.preprocessing import MinMaxScaler
from sklearn.metrics import mean_absolute_error

warnings.filterwarnings('ignore')

# Reproducibility
SEED = 42
random.seed(SEED)
np.random.seed(SEED)

SEQ_LEN    = 45    # 45 trading-day lookback window
N_EPOCHS   = 50    # capped for speed
BATCH_SIZE = 128
MC_RUNS    = 12
CACHE_DIR  = os.path.join(os.path.dirname(__file__), 'prediction_cache')
CACHE_SCHEMA_VERSION = 25  # bumped: trajectory anchored at T1M (1-month waypoint now matches predicted_price_1m)

# Dirichlet (Laplace) smoothing applied to regime probabilities before they
# leave build_regime_detector(). Mixes raw probs with a uniform prior so that
# GMM outputs like [~0, ~1, ~0] surface as [0.017, 0.967, 0.017] on the UI —
# the model's still confident, but never claims literal certainty. Alpha is
# the share of probability mass reserved for "the model could be wrong";
# 0.0 disables the smoothing entirely.
REGIME_PROB_SMOOTHING_ALPHA = 0.05

# ── Per-horizon analyst-signal boost coefficients ────────────────────────────
# metric_analysis() splits its output into non_analyst_impact + analyst_impact.
# Analyst signal is inherently long-horizon (revisions take weeks to propagate)
# so we weight it more at 6m/1y and less at 1w. The boost is multiplied
# against the analyst_impact component only; the non-analyst component is
# untouched. Target lifts at max-strength analyst signal (analyst_impact ≈ +0.09):
#   1w:    2.25% lift → boost 0.25
#   1m:    7.5%  lift → boost 0.83
#   6m/1y: 15%   lift → boost 1.67
# (MAX_ANALYST_IMPACT raised from 0.10 → 0.15; absolute ceiling lifts are
#  +3.75% / +12.5% / +25% before reliability dampening.)
ANALYST_BOOST_1W = 0.25
ANALYST_BOOST_1M = 0.83
ANALYST_BOOST_LT = 1.67

# Minimum analyst count for the analyst boost to apply on SHORT-TERM horizons.
# Below this, the short-term modules (1w, 1m) ignore analyst_impact entirely so
# noisy single-firm coverage on small caps doesn't move near-term predictions.
# Long-term horizons (6m, 1y) keep the existing reliability ramp inside
# metric_analysis() — they don't get a hard floor here.
MIN_ANALYSTS_FOR_BOOST_SHORT = 3

# Analyst sentiment scoring version. v1 = legacy consensus_value + analyst_weighted
# (the two-input recommendation/target path). v2 = time-weighted RecScore +
# capped TargetScore composed via scripts/analyst_sentiment.py with asymmetric
# Option α weights, dispersion penalty, and conviction-aware confidence pts.
ANALYST_SCORING_VERSION = os.environ.get('ANALYST_SCORING_VERSION', 'v2')


# ============================================================================
# CACHING HELPERS
# ============================================================================
def get_cache_key(ticker, historical_data):
    """Generate a unique MD5 hash for (ticker, last_date, data_len, schema_version, model_version).

    CS_MODEL_VERSION is included so that switching between long_term_cs_v1.pkl
    and long_term_cs_v2.pkl produces distinct cache entries — otherwise the
    JSON cache would silently return a stale v2 result after we flipped to v1
    (or vice versa).
    """
    if not historical_data:
        return None
    last_row = historical_data[-1]
    last_date = last_row.get('date', last_row.get('Date', ''))
    data_len = len(historical_data)
    cs_ver   = os.environ.get('CS_MODEL_VERSION', 'v2')
    legacy   = os.environ.get('USE_LEGACY_PREDICTION_MODEL', 'false')
    key_str = f"{ticker}_{last_date}_{data_len}_v{CACHE_SCHEMA_VERSION}_cs{cs_ver}_legacy{legacy}"
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
    # Volatility (30d + 60d — must both be present or `f = f[FEATURE_COLUMNS]`
    # below will strip HistVol_60 out of the DataFrame handed to the CS model,
    # which will KeyError since the retrained model now expects it as a feature).
    'HistVol_30',
    'HistVol_60',
    # Fundamentals (scalar, broadcast across rows)
    'PE_Ratio', 'PB_Ratio', 'TrailingEPS', 'ForwardEPS',
    'RevenueGrowth', 'EarningsGrowth', 'ProfitMargins',
    'DebtToEquity', 'ReturnOnEquity', 'Beta', 'DivYield',
    'AnalystPremium', 'AnalystPremiumWeighted', 'RecommendationMean',
    # Phase 1 (Tier 1) — derived Yahoo-snapshot signals (see _calculate_features_internal)
    'FCF_Yield', 'PriceToSales', 'EV_EBITDA', 'EV_Revenue',
    'CashRunwayQuarters', 'Unprofitable_Flag',
    # Phase 2 (Tier 2) — sector-relative log ratios
    'PE_LogRatio_vs_Sector', 'PB_LogRatio_vs_Sector', 'RevGrowth_Delta_vs_Sector',
    # green_v2 — additional sector-relative ratios (aligned with CS training set)
    'PS_LogRatio_vs_Sector', 'FCF_Yield_vs_Sector',
    # Phase 2 (Tier 1) — analyst rating velocity
    'Rating_Up_30d', 'Rating_Down_30d', 'Rating_Up_90d', 'Rating_Down_90d',
    'NetRating_90d', 'UpgradeScore_90d',
    # Phase 2 (Tier 2) — Google Trends momentum (live only; NaN in backtest)
    'SearchInterest_20d_Change',
    # Phase 2 (Tier 1) — analyst estimate revisions (populated once daily
    # snapshots have accumulated in analyst_estimate_history)
    'TargetMean_Revision_30d', 'EPSEst_Revision_30d_CurrQ', 'EPSEst_Revision_30d_NextQ',
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
    'IV_HV_Ratio',  # Phase 1: implied vs realized 30d vol — fear/complacency gauge
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


# ────────────────────────────────────────────────────────────────────────────
# HORIZON-SPECIFIC FEATURE MASKS (v3-split)
# ────────────────────────────────────────────────────────────────────────────
# Subsets of FEATURE_COLUMNS that each horizon model trains/predicts on.
# Close is in both (it's the target). Regime columns are added dynamically
# by the orchestrator and included in both horizons' effective input via
# extend_with_regime_cols() below.

SHORT_TERM_FEATURES = [
    # OHLCV — essential
    'Open', 'High', 'Low', 'Close', 'Volume',
    # Short-horizon technical indicators
    'MACD', 'MACD_Signal',
    'BB_Upper', 'BB_Lower', 'BB_Mid',
    'RSI_14',
    'STOCH_K', 'STOCH_D',
    'ATR_14',
    'SMA_20', 'EMA_50',
    # Volatility / volume (intraday-ish risk)
    'HistVol_30',
    'IV', 'IV_Rank', 'Put_Call_Ratio', 'IV_HV_Ratio',
    # Regime flag — lets the short-term model learn different weightings on
    # loss-makers (thin retail flow, different reaction to earnings, etc).
    'Unprofitable_Flag',
    # Phase 2 (Tier 2) — sector-relative valuation. Short-term price often
    # reverts toward sector peers; these features expose that channel.
    'PE_LogRatio_vs_Sector', 'PB_LogRatio_vs_Sector', 'RevGrowth_Delta_vs_Sector',
    'PS_LogRatio_vs_Sector', 'FCF_Yield_vs_Sector',
    # Phase 2 (Tier 1) — analyst rating velocity. Analyst upgrade momentum
    # is one of the strongest predictors at 1w/1m horizons per finance
    # literature (short-term retail follows analyst calls).
    'Rating_Up_30d', 'Rating_Down_30d', 'NetRating_90d', 'UpgradeScore_90d',
    # Phase 2 (Tier 2) — Google Trends momentum. Retail attention often
    # leads price for consumer/meme names. NaN in backtest, active in live.
    'SearchInterest_20d_Change',
    # Phase 2 (Tier 1) — analyst estimate revisions. Backtest-null until
    # daily snapshots have accumulated; live serving uses them once ready.
    'TargetMean_Revision_30d', 'EPSEst_Revision_30d_CurrQ', 'EPSEst_Revision_30d_NextQ',
    # 52w positioning (drives short-term mean-reversion + breakout)
    'HiRatio_52w', 'LoRatio_52w',
    'FiftyTwoWeek_PosRatio',
    # Lag features — explicit past-price inputs (Improvement 1)
    'Close_lag_5', 'Close_lag_10', 'Close_lag_20',
    'Volume_lag_5',
    # Short-term ROC + returns (Improvement 2)
    'ROC_5d', 'ROC_20d',
    'Return_1d', 'Return_5d', 'Return_20d',
    # Trend + breakout (Improvement 3)
    'PriceToHigh_20d', 'PriceToLow_20d', 'PriceToHigh_5d',
    'VolumePriceTrend',
    'EMA_Slope_10', 'EMA_Slope_20',
    # Rolling return stats (Improvement 4) — momentum compression
    'RollingMean_20d', 'RollingStd_20d',
    'RollingSkew_20d', 'RollingSharpe_20d',
    # Microstructure / pre-market gap
    'PreMarket_GapPct', 'PostMarket_GapPct',
    # Earnings-window dampening
    'Earnings_In_Window',
    'Days_To_Next_Earnings', 'Days_Since_Last_Earnings',
    # Sentiment + calendar
    'NewsSentiment', 'EarningsBeatStreak',
    'Month_Sin', 'Month_Cos', 'EarningsSeason',
    # Vol term-structure proxy
    'VIX_RealVol_Ratio', 'PC_Skew_Proxy',
    # Peer RS — short-horizon relative move
    'Peer_RS_5d',
    # Post-earnings drift — short-horizon catalyst window
    'PostEarnings_DayN', 'PostEarnings_CumReturn', 'PostEarnings_VolRatio',
]

LONG_TERM_FEATURES = [
    # OHLCV — essential (Close is the target)
    'Close', 'Volume',
    # Long-horizon moving averages + trend
    'SMA_20', 'EMA_50', 'SMA_200', 'EMA_200',
    'GoldenCross',
    # Long-horizon ROC + 52w positioning
    'HiRatio_52w', 'LoRatio_52w',
    'ROC_6m', 'ROC_12m',
    # Volatility (30d + 60d — 60d is the smoother realized-vol signal the CS
    # model uses to self-attenuate on high-vol names like WULF; 30d retained
    # so short-term feature masks that reference it don't break).
    'HistVol_30',
    'HistVol_60',
    # Fundamentals — drives 6m/1y revaluation
    'PE_Ratio', 'PB_Ratio', 'TrailingEPS', 'ForwardEPS',
    'RevenueGrowth', 'EarningsGrowth', 'ProfitMargins',
    'DebtToEquity', 'ReturnOnEquity', 'Beta', 'DivYield',
    'AnalystPremium', 'AnalystPremiumWeighted', 'RecommendationMean',
    # Phase 1 (Tier 1) — cash-based valuation, alt ratios, runway, regime flag
    'FCF_Yield', 'PriceToSales', 'EV_EBITDA', 'EV_Revenue',
    'CashRunwayQuarters', 'Unprofitable_Flag',
    # Phase 2 (Tier 2) — sector-relative valuation for cross-sectional revaluation
    'PE_LogRatio_vs_Sector', 'PB_LogRatio_vs_Sector', 'RevGrowth_Delta_vs_Sector',
    'PS_LogRatio_vs_Sector', 'FCF_Yield_vs_Sector',
    # Phase 2 (Tier 1) — analyst rating velocity + estimate revisions
    'Rating_Up_90d', 'Rating_Down_90d', 'NetRating_90d',
    'TargetMean_Revision_30d', 'EPSEst_Revision_30d_CurrQ', 'EPSEst_Revision_30d_NextQ',
    # Macro
    'VIX', 'VIX_20d_Avg', 'Treasury10Y', 'SectorETF_60d_Corr',
    # Credit risk proxy
    'HYG_Level', 'HYG_Mom_20d',
    'LQD_Level', 'LQD_Mom_20d',
    'HYG_LQD_Ratio',
    # Dollar
    'DXY_Level', 'DXY_Return_20d',
    # Rates / curve
    'Treasury3M', 'CurveSlope_10M3M',
    # Relative strength
    'RS_vs_SPY_20d', 'RS_vs_SectorETF_20d',
    # Commodities betas
    'WTI_Return_20d', 'WTI_Beta_60d',
    'Copper_Return_20d', 'Copper_Beta_60d',
    'Wheat_Return_20d', 'Wheat_Beta_60d',
    # World Bank macro (annual)
    'WorldBank_GDP', 'WorldBank_Inflation',
    'WorldBank_Consumption', 'WorldBank_Real_GDP',
    # Insider activity (90d)
    'InsiderNetSellRatio_90d', 'InsiderTxCount_90d',
    # Earnings surprises + short interest
    'EPS_Surprise_Avg_4Q', 'Revenue_Surprise_Avg_4Q',
    'ShortFloatPct', 'DaysToCover',
    # EPS revision velocity + analyst upgrades
    'EPS_Revision_7d_0Q', 'EPS_Revision_7d_1Q',
    'Revenue_Est_Growth_0Q', 'Revenue_Est_Growth_1Q',
    'EPS_Rev_Up7d', 'EPS_Rev_Down7d',
    'Upgrade_Score_7d', 'Upgrade_Score_30d',
    # Institutional ownership
    'Institution_PctHeld', 'Institution_PctDelta',
    # Sentiment (still informative on long horizons but secondary)
    'NewsSentiment', 'EarningsBeatStreak',
    # Calendar (seasonality at long horizons)
    'Month_Sin', 'Month_Cos',
]


def extend_with_regime_cols(feature_list):
    """Return feature_list + the 11 regime/interaction columns. Both horizons
    use the regime context, so it's appended to whichever mask the caller
    selects without duplicating it in SHORT_/LONG_TERM_FEATURES above."""
    regime_extras = (
        [f'Regime_{i}' for i in range(4)] +
        [f'Regime_Prob_{i}' for i in range(4)] +
        ['Regime_x_PC_Ratio', 'Regime_x_HYG_LQD', 'Regime_x_RS_SPY']
    )
    return list(feature_list) + regime_extras


def make_horizon_sequences(scaled, targets, mask_indices):
    """
    Build X using only the columns at `mask_indices`, paired with the given
    1-D `targets` vector (already in scaled-close space).

    Returns (X, Y) where X has shape (n_samples, SEQ_LEN * len(mask_indices))
    and Y is the 1-D target column (or 2-D if `targets` was 2-D).
    """
    masked = scaled[:, mask_indices]
    n_samples = len(masked) - SEQ_LEN
    if n_samples <= 0:
        return np.array([], dtype=np.float32), np.array([], dtype=np.float32)

    from numpy.lib.stride_tricks import sliding_window_view
    X = sliding_window_view(masked[:-1], (SEQ_LEN, masked.shape[1])).squeeze(1)
    X = X.reshape(n_samples, -1)

    if targets.ndim == 1:
        Y = targets[SEQ_LEN:].reshape(-1, 1)
    else:
        Y = targets[SEQ_LEN:]

    return X.astype(np.float32), Y.astype(np.float32)


def slice_last_seq(scaled, mask_indices):
    """Return the trailing SEQ_LEN window of `scaled`, masked to mask_indices,
    flattened to a single 1-D prediction input (1, SEQ_LEN * len(mask))."""
    masked_last = scaled[-SEQ_LEN:, mask_indices]
    return masked_last.flatten().reshape(1, -1).astype(np.float32)


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

    # Prefer FRED values (nightly, US-specific) over stale annual World Bank data.
    # FRED keys: CPIAUCSL→inflation YoY%, GDP→QoQ%, FEDFUNDS→level.
    # Falls back to WorldBank if FRED row is absent.
    fred = macro_data.get('fred', {}) or {}
    def fred_val(series_id, field, fallback):
        row = fred.get(series_id)
        if row and row.get(field) is not None:
            return float(row[field])
        return fallback

    wb_gdp        = safe(indicators.get('gdpGrowth'), 2.0)
    wb_inflation  = safe(indicators.get('inflation'), 2.5)
    wb_consumption= safe(indicators.get('consumptionGrowth'), 2.0)

    # GDP QoQ% from FRED is annualised-equivalent; scale to match WB annual units
    gdp_val        = fred_val('GDP',      'qoq_pct',  wb_gdp)
    inflation_val  = fred_val('CPIAUCSL', 'yoy_pct',  wb_inflation)
    consumption_val= wb_consumption  # no direct FRED equivalent; keep WB

    f['WorldBank_GDP']         = gdp_val
    f['WorldBank_Inflation']   = inflation_val
    f['WorldBank_Consumption'] = consumption_val
    f['WorldBank_Real_GDP']    = gdp_val - inflation_val

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
        fred = macro_data.get('fred', {}) or {}
        def _fv(sid, field, fb):
            row = fred.get(sid)
            return float(row[field]) if row and row.get(field) is not None else fb
        gdp_val       = _fv('GDP',      'qoq_pct', safe(indicators.get('gdpGrowth'), 2.0))
        inflation_val = _fv('CPIAUCSL', 'yoy_pct', safe(indicators.get('inflation'), 2.5))
        f['WorldBank_GDP']         = gdp_val
        f['WorldBank_Inflation']   = inflation_val
        f['WorldBank_Consumption'] = safe(indicators.get('consumptionGrowth'), 2.0)
        f['WorldBank_Real_GDP']    = gdp_val - inflation_val

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

    # Historical volatility — 30d retained for the short-term features; the
    # 60d companion is added so the long-term CS model can self-attenuate on
    # a smoother realized-vol signal. Same annualization convention.
    log_ret = np.log(pd.Series(close) / pd.Series(close).shift(1))
    f['HistVol_30'] = log_ret.rolling(30).std().values * np.sqrt(252)
    f['HistVol_60'] = log_ret.rolling(60).std().values * np.sqrt(252)

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

    # ── Phase 1 (Tier 1) — derived Yahoo-snapshot features ───────────────────
    # Nothing new from Yahoo; just derived signals the model didn't have exposure
    # to before. Each guards against divide-by-zero and negative-denominator
    # edge cases (unprofitable/distressed names) that would otherwise emit NaN.
    market_cap_val = safe(stock_metrics.get('marketCap'), 0.0)
    fcf_val        = safe(stock_metrics.get('freeCashflow'), 0.0)
    ocf_val        = safe(stock_metrics.get('operatingCashflow'), 0.0)
    total_cash_val = safe(stock_metrics.get('totalCash'), 0.0)
    total_debt_val = safe(stock_metrics.get('totalDebt'), 0.0)

    # Free cash flow yield — real cash generated / market value. Negative for
    # cash-burning names (WULF etc), which is actually informative — leave the
    # sign, just guard against div-by-zero.
    f['FCF_Yield'] = (fcf_val / (market_cap_val + 1e-9)) if market_cap_val > 0 else 0.0

    # Alternative valuation ratios — meaningful when P/E is undefined for
    # unprofitable names. Yahoo returns them as raw ratios; clamp to sane
    # bounds to keep training stable (WULF's EV/Revenue is 81x — real, but a
    # tail value that would swamp the scaler if left unclipped).
    f['PriceToSales'] = max(-1e3, min(1e3, safe(stock_metrics.get('priceToSales'), 0.0)))
    f['EV_EBITDA']    = max(-1e3, min(1e3, safe(stock_metrics.get('enterpriseToEbitda'), 0.0)))
    f['EV_Revenue']   = max(-1e3, min(1e3, safe(stock_metrics.get('enterpriseToRevenue'), 0.0)))

    # Cash runway (quarters). Uses operating cashflow to strip out CapEx —
    # for capex-heavy growth names like WULF, FCF understates real runway
    # because they're choosing to invest. When OCF is positive the company
    # isn't burning cash → runway is effectively infinite → cap at 100q.
    if ocf_val >= 0:
        f['CashRunwayQuarters'] = 100.0
    else:
        quarterly_burn = -ocf_val / 4.0
        f['CashRunwayQuarters'] = min(100.0, total_cash_val / (quarterly_burn + 1e-9))

    # Unprofitable regime flag — lets the model learn different feature
    # weightings for loss-makers (P/E imputed to sector median is a lie for
    # these names; sector-relative P/S / EV/Rev are more meaningful).
    f['Unprofitable_Flag'] = 1.0 if teps < 0 else 0.0

    # ── Phase 2 (Tier 2) — Sector-relative log ratios ────────────────────────
    # "This stock's PE is 2× its sector median" is often more predictive than
    # the raw PE. Uses log ratios (natural for multiplicative quantities and
    # symmetric around 0) so a stock at 0.5× the median gets -0.69 and one at
    # 2× gets +0.69. Bounded to keep the scaler stable. Zero when either side
    # is unavailable.
    sec_pe   = safe(stock_metrics.get('sectorMedianPe'), 0.0)
    sec_pb   = safe(stock_metrics.get('sectorMedianPb'), 0.0)
    sec_ps   = safe(stock_metrics.get('sectorMedianPs'), 0.0)
    sec_revg = safe(stock_metrics.get('sectorMedianRevenueGrowth'), 0.0)
    sec_fcfy = safe(stock_metrics.get('sectorMedianFcfYield'), 0.0)

    f['PE_LogRatio_vs_Sector'] = (float(np.log(max(1e-3, pe) / max(1e-3, sec_pe)))
                                  if pe > 0 and sec_pe > 0 else 0.0)
    f['PB_LogRatio_vs_Sector'] = (float(np.log(max(1e-3, pb) / max(1e-3, sec_pb)))
                                  if pb > 0 and sec_pb > 0 else 0.0)
    # Growth is a signed percentage — subtract the sector delta directly.
    f['RevGrowth_Delta_vs_Sector'] = max(-2.0, min(2.0, revg - sec_revg))

    # green_v2 additions — sector-relative PS and FCF yield. Names match the
    # CS training feature list so a retrain can consume them consistently.
    # Recompute the scalar FCF Yield here (rather than reading from f, which
    # would return a broadcast Series inside a DataFrame context) so the delta
    # math stays scalar.
    stock_ps   = safe(stock_metrics.get('priceToSales'), 0.0)
    _fcfy_scalar = (fcf_val / (market_cap_val + 1e-9)) if market_cap_val > 0 else 0.0
    f['PS_LogRatio_vs_Sector'] = (float(np.log(max(1e-3, stock_ps) / max(1e-3, sec_ps)))
                                  if stock_ps > 0 and sec_ps > 0 else 0.0)
    # FCF yield is signed → raw delta, clamped so absent-data zeros don't skew.
    f['FCF_Yield_vs_Sector'] = max(-2.0, min(2.0, float(_fcfy_scalar) - float(sec_fcfy)))

    # ── Phase 2 (Tier 1) — Analyst rating velocity ───────────────────────────
    # Raw counts + 90d window. Complements the existing normalized
    # upgradeScore7d/30d (which collapses "5 ups + 5 downs" and "0 events"
    # both to 0) by exposing volume separately from net sign. Backtest-friendly
    # since we filter Yahoo's upgradeDowngradeHistory by as-of date.
    _fm = feature_metrics or {}
    f['Rating_Up_30d']    = max(0.0, safe(_fm.get('ratingUp30d'),   0.0))
    f['Rating_Down_30d']  = max(0.0, safe(_fm.get('ratingDown30d'), 0.0))
    f['Rating_Up_90d']    = max(0.0, safe(_fm.get('ratingUp90d'),   0.0))
    f['Rating_Down_90d']  = max(0.0, safe(_fm.get('ratingDown90d'), 0.0))
    f['NetRating_90d']    = f['Rating_Up_90d'] - f['Rating_Down_90d']
    f['UpgradeScore_90d'] = max(-1.0, min(1.0, safe(_fm.get('upgradeScore90d'), 0.0)))

    # ── Phase 2 (Tier 2) — Google Trends momentum (live only, NaN in backtest) ─
    # 20-day change in normalized search interest. Retail attention often
    # leads price for consumer/meme names. When the trends channel is
    # unavailable (backtest disables it; live serving falls back gracefully),
    # we emit NaN and let the model treat it as missing.
    _trends_val = _fm.get('searchInterest_20d_change') if _fm else None
    f['SearchInterest_20d_Change'] = float(_trends_val) if isinstance(_trends_val, (int, float)) else np.nan

    # ── Phase 2 (Tier 1) — Analyst estimate revisions (live only) ─────────────
    # Requires 30 days of persisted snapshots in analyst_estimate_history to
    # start emitting non-null values. Nulls flow through as NaN and the model
    # treats them as missing (imputed to 0 by fillna). Backfilled by
    # update_predictions.py once the daily-snapshot job has been running.
    f['TargetMean_Revision_30d']    = float(_fm['targetMeanRevision30d'])    if isinstance(_fm.get('targetMeanRevision30d'),    (int, float)) else np.nan
    f['EPSEst_Revision_30d_CurrQ']  = float(_fm['epsEstRevision30dCurrQ'])   if isinstance(_fm.get('epsEstRevision30dCurrQ'),   (int, float)) else np.nan
    f['EPSEst_Revision_30d_NextQ']  = float(_fm['epsEstRevision30dNextQ'])   if isinstance(_fm.get('epsEstRevision30dNextQ'),   (int, float)) else np.nan

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

    # ── Phase 1 — IV/HV spread ────────────────────────────────────────────────
    # Ratio of options-implied to realized 30d vol. > 1 = market pricing event
    # risk vs recent realized (elevated fear); < 1 = complacency. Both inputs
    # are already computed above; we just derive the ratio. NaN if either side
    # is missing (options data unavailable for illiquid names, or history is
    # too short for HistVol_30).
    _iv_arr = np.asarray(f['IV'], dtype=np.float64) if hasattr(f['IV'], '__len__') else np.full(n, float(f['IV']), dtype=np.float64)
    _hv_arr = np.asarray(f['HistVol_30'], dtype=np.float64) if hasattr(f['HistVol_30'], '__len__') else np.full(n, float(f['HistVol_30']), dtype=np.float64)
    with np.errstate(divide='ignore', invalid='ignore'):
        _iv_hv = _iv_arr / (_hv_arr + 1e-9)
    _iv_hv = np.where(np.isfinite(_iv_hv), _iv_hv, np.nan)
    _iv_hv = np.clip(_iv_hv, 0.0, 10.0)  # ratio > 10 is a data glitch, not signal
    f['IV_HV_Ratio'] = _iv_hv

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
# REGIME DETECTION
# ============================================================================
def _dirichlet_smooth(probs, alpha=REGIME_PROB_SMOOTHING_ALPHA):
    """Mix probs with a uniform prior. alpha=0 is a no-op.

    Cleans up GMM outputs that, on data points sitting inside one Gaussian,
    return values like [1e-15, 0.9999, 1e-12] — useful information for
    Bayes math, misleading on a UI bar chart. Linear smoothing preserves
    the rank order and only redistributes a fixed `alpha` share of mass.
    """
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
    output is never a hard one-hot. All return paths run their probabilities
    through `_dirichlet_smooth()` so a confident GMM still surfaces with a
    small reserved mass on the other regimes (UI-friendly without distorting
    legitimate uncertainty).
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
        # Soft probabilities from cluster distances. Lower distance → higher
        # probability. Temperature 1.0 is gentle — chosen so a sample sitting
        # squarely in one cluster still gets ~0.7 on that cluster (not 1.0),
        # which is closer to what a GMM with reasonable variance would emit.
        distances = km.transform(market_vec_norm)  # (n_samples, n_clusters)
        # Center distances per row before softmax for numerical stability,
        # then negate so smaller distance = larger logit.
        logits = -(distances - distances.min(axis=1, keepdims=True))
        exp = np.exp(logits)
        probs = exp / exp.sum(axis=1, keepdims=True)
        return labels, _dirichlet_smooth(probs)
    except:
        # Last-resort: uniform probabilities so downstream consumers never see
        # NaN or a degenerate one-hot from this code path. Smoothing a uniform
        # vector with a uniform prior is a no-op, so we skip it here.
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


# ============================================================================
# SEQUENCE BUILDER
# ============================================================================
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
def confidence_score(cv_mape, history_years, imputed_fields, analyst_count, analyst_sentiment_v2=None,
                     return_breakdown: bool = False):
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

    # Analyst component (15 pts max) — two paths:
    #   v2: split into coverage (up to 8 pts) + conviction (up to 7 pts), computed
    #       upstream by analyst_sentiment.compute_analyst_sentiment(). Rewards both
    #       deep coverage AND a decisive FinalScore (close to 0 or 100).
    #   v1: legacy step function on raw analyst_count.
    if analyst_sentiment_v2 is not None:
        cov_pts  = int(analyst_sentiment_v2.get('coverage_pts', 0))
        conv_pts = int(analyst_sentiment_v2.get('conviction_pts', 0))
        analyst_pts = max(0, min(15, cov_pts + conv_pts))
        pts += analyst_pts
        breakdown['analyst'] = analyst_pts
    else:
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

    if return_breakdown:
        # Rich structure so the UI can build a plain-language "why is confidence
        # low?" tooltip. Includes both the raw input values (so the UI can say
        # "±20% cross-validation error") and the point contributions (so it
        # can identify which component is doing the docking).
        rich = {
            'total': final_score,
            'components': {
                'cv_mape':  {'points': breakdown.get('cv_mape', 0),  'max': 40, 'value': float(cv_mape)},
                'history':  {'points': breakdown.get('history', 0),  'max': 25, 'value': float(history_years)},
                'features': {'points': breakdown.get('features', 0), 'max': 20, 'imputed_fields': list(imputed_fields or [])},
                'analyst':  {'points': breakdown.get('analyst', 0),  'max': 15, 'analyst_count': int(analyst_count or 0)},
            },
        }
        # Signal confidence: model-internal certainty derived from CV MAPE +
        # feature completeness (the two components that measure how well the
        # model knows this stock, independent of the prediction magnitude).
        # Normalized to 0–100 (max 60 pts from these two components).
        sig_pts = breakdown.get('cv_mape', 0) + breakdown.get('features', 0)
        rich['signal_confidence'] = int(round(min(100, sig_pts / 60.0 * 100)))
        return final_score, rich
    return final_score


def compute_precedent_confidence(
    closes: 'np.ndarray',
    predicted_pct: float,
    horizon_days: int,
) -> int:
    """
    Empirical base rate: % of historical rolling windows where the stock
    realized a move >= predicted_pct in the same direction.

    - Near-flat prediction (<0.5%) → returns 70 (small moves are common).
    - Insufficient history         → returns 50 (neutral).
    - Returns 0–100.
    """
    import numpy as np
    closes = np.asarray(closes, dtype=float)
    if len(closes) < horizon_days + 20:
        return 50
    if abs(predicted_pct) < 0.5:
        return 70
    direction = 1 if predicted_pct >= 0 else -1
    threshold = abs(predicted_pct) / 100.0
    stride = max(1, horizon_days // 5)
    total = matched = 0
    for i in range(0, len(closes) - horizon_days, stride):
        p0, p1 = closes[i], closes[i + horizon_days]
        if p0 <= 0:
            continue
        ret = (p1 - p0) / p0
        total += 1
        if direction == 1 and ret >= threshold:
            matched += 1
        elif direction == -1 and ret <= -threshold:
            matched += 1
    if total == 0:
        return 50
    return int(round(matched / total * 100))


# ============================================================================
# LEGACY METRIC ANALYSIS
# ============================================================================
def metric_analysis(df, stock_metrics, news_sentiment, growth_rate, is_uptrend, earnings_beat_streak, external_tech_score=0.0, consensus_value=0.0, analyst_weighted=0.0, analyst_count=0, analyst_sentiment_v2=None):
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

    # Track analyst-derived contributions separately from everything else so the
    # short-term and long-term modules can weight them differently per horizon.
    # See ANALYST_BOOST_{1W,1M,LT} below for the per-horizon multipliers.
    non_analyst_impact = 0.0
    analyst_impact = 0.0

    # Internal heuristics (dampened to prevent double-counting with external_tech_score)
    if rsi > 75:   non_analyst_impact -= 0.015
    elif rsi < 25: non_analyst_impact += 0.015

    if is_uptrend: non_analyst_impact += 0.02
    else:          non_analyst_impact -= 0.01  # less penalizing for stable/consolidating stocks

    capped_growth = max(-10.0, min(10.0, growth_rate))
    non_analyst_impact += (capped_growth / 100) * 0.03
    non_analyst_impact += news_sentiment * 0.015

    # ── Reliability scalar (used by both tech score and consensus below) ──
    # Scales down signals for low-coverage stocks so a micro-cap with 4 analysts
    # doesn't get the same uplift weighting as a large-cap with 40+ analysts.
    _reliability = min(analyst_count / 40.0, 1.0)

    # ── External Technical Indicator Influence ──
    # Reliability-weighted and capped at 2% max so a momentum spike with 10+ buy
    # signals on a low-coverage stock doesn't dominate the impact multiplier.
    _ext_tech_contribution = external_tech_score * 0.005 * _reliability
    non_analyst_impact += min(_ext_tech_contribution, 0.02)

    # ── Analyst contribution: v1 (consensus + target_premium) OR v2 (FinalScore) ──
    if analyst_sentiment_v2 is not None:
        # v2: use the pre-computed FinalScore-derived analyst_impact directly.
        # The analyst_sentiment module already applied reliability dampening and
        # dispersion penalty, so no further scaling here.
        analyst_impact += float(analyst_sentiment_v2.get('analyst_impact', 0.0))
    else:
        # v1: original two-input formula. Kept for backward compat / A-B testing
        # via ANALYST_SCORING_VERSION='v1' env override.
        #
        # ── Analyst Consensus Influence (0.0 to 1.0) ──
        # Reliability-weighted so low-coverage stocks (e.g. 4 analysts) don't get the
        # same bullish lift as well-covered stocks (e.g. 40+ analysts). Without this,
        # a "buy" rating on a stock where analysts' actual price target is -38% vs current
        # price would still add the full +3.75% — drowning out the bearish target signal.
        analyst_impact += consensus_value * 0.05 * _reliability

        # ── Analyst Numerical Target Premium (0.0 to 1.0) ──
        # Directly nudges prediction toward the analyst target mean.
        # analyst_weighted already incorporates reliability (analystOpinionCount / 40),
        # so no further reliability scaling is needed here. Deep-coverage stocks get a
        # modest boost (up to 1.5x) to reward strong analyst alignment.
        analyst_coverage_boost = min(analyst_count / 40.0, 1.5)
        analyst_impact += analyst_weighted * 0.05 * analyst_coverage_boost

    # ── Earnings Beat Streak influence (0-4 quarters) ──
    # Adds ~1.0% per beat (was 0.5%). Max +4%.
    non_analyst_impact += earnings_beat_streak * 0.01

    # ── High-Beta / Valuation Stretch Penalty ──
    # High-beta stocks near 52w highs are prone to sharp mean-reversion.
    _beta = safe(stock_metrics.get('beta'), 1.0)
    _hi_ratio = float(df['HiRatio_52w'].iloc[-1]) if 'HiRatio_52w' in df.columns else 0.0
    if _beta > 2.5 and _hi_ratio > 0.95:
        stretch_penalty = 1.0 - ((_beta - 2.5) * 0.015)
        non_analyst_impact += stretch_penalty - 1.0

    total_impact = non_analyst_impact + analyst_impact

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
        "non_analyst_impact":    round(float(non_analyst_impact), 4),
        "analyst_impact":        round(float(analyst_impact), 4),
        "impact_classification": (
            "very_bullish" if total_impact > 0.08 else
            "bullish"      if total_impact > 0.04 else
            "neutral"      if total_impact > -0.04 else
            "bearish"      if total_impact > -0.08 else
            "very_bearish"
        ),
    }


# ============================================================================
# SANITIZATION
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
      1y  : ±85%  (prevents $0 predictions; 15% floor on current price)

    Cross-horizon consistency: if same-sign 6m magnitude overshoots 1y
    magnitude by >1.5× AND |pct_6m| > 15%, the 6m head is treated as an
    outlier extrapolation and clamped to 1.3× pct_1y (same sign). A
    genuine 6m move that big on a liquid name should persist or grow by
    1y, not revert. Thresholds tuned from v3split backtest distribution
    (5 of 80 same-signed pairs trip; offenders cluster at ratio >1.6).

    When any clamp fires for a horizon, that horizon's confidence_score is
    knocked down to 25 (a clamped prediction is a low-trust prediction).
    Writes a one-line stderr note so the clamp event is visible in logs.
    """
    # ── NaN / Inf safety net ─────────────────────────────────────────────
    # Python's json.dumps (allow_nan=True default) serialises NaN as the
    # bare token `NaN`, which is not valid JSON. JavaScript's JSON.parse
    # then throws, causing the Next.js route to fall back to the statistical
    # model. NaN also fails every Python comparison, so the clamp logic
    # below would silently let it pass through untouched. Walk the result
    # dict recursively and replace any NaN/Inf float with None (→ JSON null)
    # before any horizon logic runs.
    def _strip_nan(obj):
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
        if isinstance(obj, dict):
            return {k: _strip_nan(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_strip_nan(v) for v in obj]
        return obj

    nan_keys = [k for k, v in result.items()
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v))]
    if nan_keys:
        print(f"[sanitize] {result.get('ticker', '?')}: NaN/Inf in {nan_keys} → replacing with None",
              file=sys.stderr)
    result = _strip_nan(result)

    # Z-score horizon-aware caps (Item 3). Each horizon's cap is derived from
    # annualized vol scaled by √(horizon_days/252), then multiplied by Z_CAP=2.5.
    # This means a 30%-vol stock gets: 1w→4.7%, 1m→9.7%, 6m→23.8%, 1y→33.6%
    # before the absolute floors kick in. Absolute floors prevent caps from
    # collapsing to near-zero for ultra-low-vol names and ensure a realistic
    # minimum prediction envelope.
    vol = result.get('realized_vol_60d')
    sigma_annual = vol if isinstance(vol, (int, float)) and vol > 0 else 0.30
    Z_CAP = 2.5
    _horizon_days  = {'1w': 5,    '1m': 21,   '6m': 126,  '1y': 252}
    _abs_floors    = {'1w': 7.0,  '1m': 12.0, '6m': 30.0, '1y': 40.0}
    horizons = [
        (h, max(_abs_floors[h], Z_CAP * sigma_annual * math.sqrt(days / 252) * 100))
        for h, days in _horizon_days.items()
    ]
    # Keep vol_mult for the pre-clamp in predict_weighted_analysis.py.
    vol_mult = max(1.0, min(2.5, sigma_annual / 0.30))

    ticker = result.get('ticker', '?')
    current_price = result.get('regularMarketPrice')

    # Collect clamp events so cross-horizon confidence rules (Proposal A) can
    # inspect BOTH 6m and 1y states before deciding whether to floor to 25 or
    # keep the model's own confidence.
    clamp_events: dict[str, dict] = {}

    for h, bound in horizons:
        price_key = f'predicted_price_{h}'
        pct_key   = f'predicted_change_pct_{h}'
        conf_key  = f'confidence_score_{h}'
        range_key = f'predicted_range_{h}'
        price = result.get(price_key)
        pct   = result.get(pct_key)
        if price is None or pct is None:
            continue
        price_floored = False
        pct_clamped   = False
        new_pct = pct
        # Capture the model's pre-clamp confidence in case Proposal A restores it.
        original_conf = result.get(conf_key)
        # Floor price at 0.01 — negative prices are unphysical.
        # Also sync pct so price and pct stay consistent (avoids $0 display
        # when pct stays at -100% while price is floored to 0.01).
        if isinstance(price, (int, float)) and price < 0.01:
            print(f"[sanitize] {ticker} {h}: price {price} → 0.01 (was negative)", file=sys.stderr)
            result[price_key] = 0.01
            if isinstance(current_price, (int, float)) and current_price > 0:
                result[pct_key] = round((0.01 - current_price) / current_price * 100, 4)
                new_pct = result[pct_key]
            price_floored = True
        # Clamp change pct + recompute price so they stay in sync
        if isinstance(pct, (int, float)) and abs(pct) > bound:
            new_pct = max(-bound, min(bound, pct))
            print(f"[sanitize] {ticker} {h}: change_pct {pct} → {new_pct} "
                  f"(out of ±{bound:.1f}% bound, vol_mult={vol_mult:.2f})", file=sys.stderr)
            result[pct_key] = new_pct
            if isinstance(current_price, (int, float)) and current_price > 0:
                result[price_key] = round(current_price * (1 + new_pct / 100), 2)
            pct_clamped = True
        if price_floored or pct_clamped:
            # Item 2: widen the spread proportionally to how much the prediction
            # was clipped. A prediction clipped 40% beyond the cap gets a range
            # 40% wider than the MC-derived band, communicating "we're uncertain
            # about the exact level, not the direction." Price-floor events
            # (numerically broken) don't widen — they're already treated as Low.
            widen_factor = 1.0
            if pct_clamped and isinstance(pct, (int, float)) and abs(new_pct) > 1e-6:
                clamp_ratio = abs(pct - new_pct) / (abs(new_pct) + 1e-9)
                widen_factor = 1.0 + min(1.5, clamp_ratio)

            # Re-center stored range on updated price + apply widen.
            old_range = result.get(range_key)
            if isinstance(old_range, (list, tuple)) and len(old_range) == 2:
                spread = (old_range[1] - old_range[0]) * widen_factor
                new_center = result[price_key]
                result[range_key] = [round(new_center - spread / 2, 2),
                                     round(new_center + spread / 2, 2)]

            # Same fix for the 18-month trajectory waypoints the UI actually
            # reads for the 1m/6m/1y card ranges (StockPrediction.tsx reads
            # monthly_trajectory[1], [6], and [12], not predicted_range_*).
            traj_idx = {'1m': 1, '6m': 6, '1y': 12}.get(h)
            trajectory = result.get('monthly_trajectory')
            if traj_idx is not None and isinstance(trajectory, list) and len(trajectory) > traj_idx:
                wp = trajectory[traj_idx]
                if isinstance(wp, dict):
                    lo, hi = wp.get('lower_bound'), wp.get('upper_bound')
                    old_spread = (hi - lo) if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) else 0.0
                    new_spread = old_spread * widen_factor
                    new_center = result[price_key]
                    wp['predicted_price'] = round(new_center, 2)
                    wp['lower_bound']     = round(new_center - new_spread / 2, 2)
                    wp['upper_bound']     = round(new_center + new_spread / 2, 2)
            # Confidence decisions deferred to the post-loop pass so 6m/1y can
            # see each other's clamp state (Proposal A: coherent-extrapolation
            # keeps the model's own confidence; outlier still floors to 25).
            clamp_events[h] = {
                'price_floored': price_floored,
                'pct_clamped':   pct_clamped,
                'new_pct':       new_pct,
                'original_conf': original_conf,
                'widen_factor':  widen_factor,
            }

    # ── Post-loop confidence rules ────────────────────────────────────────
    # 1w: preserve the existing "consistent-with-1m ceiling hit is fine" logic.
    if '1w' in clamp_events:
        ev = clamp_events['1w']
        if ev['price_floored']:
            result['confidence_score_1w'] = 25
            result['confidence_reason_1w'] = (
                'Raw 1-week price prediction was invalid (below zero) — likely a numerical '
                'issue with this stock. Target and confidence forced to safe defaults.'
            )
        else:
            pct_1m_raw = result.get('predicted_change_pct_1m')
            same_dir = (isinstance(pct_1m_raw, (int, float))
                        and (ev['new_pct'] >= 0) == (pct_1m_raw >= 0))
            below_1m = (isinstance(pct_1m_raw, (int, float))
                        and abs(ev['new_pct']) < abs(pct_1m_raw))
            if not (same_dir and below_1m):
                result['confidence_score_1w'] = 25
                result['confidence_reason_1w'] = (
                    '1-week prediction hit the volatility-scaled ceiling AND disagreed with '
                    'the 1-month direction. Treated as an outlier extrapolation; confidence '
                    'lowered to Low.'
                )

    # 1m: no cross-horizon rule — always floor when clamped.
    if '1m' in clamp_events:
        result['confidence_score_1m'] = 25
        result['confidence_reason_1m'] = (
            '1-month prediction was extreme (outside the volatility-scaled ceiling). '
            'Target clamped and confidence lowered to Low as a safety measure.'
        )

    # 6m / 1y — Proposal A (signal-aware) + Proposal D (directional pill flag).
    #
    # We accept three coherence patterns; each keeps the model's own confidence
    # and flags the clamped horizon(s) as "at model ceiling" for the UI pill.
    # The un-clamped horizon in a one-sided case must have meaningful magnitude
    # (|pct| ≥ half its own vol-scaled cap) in the same direction as the
    # clamped horizon, so we don't accept a spike+flat pair as "coherent."
    #
    #   1. Both 6m and 1y clamped, same direction. (Original case.)
    #   2. Only 1y clamped, 6m same-signed, |pct_6m| ≥ 0.5 × cap_6m_scaled.
    #      (Typical high-growth name: +57% at 6m → +130%(clamped 100%) at 1y.)
    #   3. Only 6m clamped, 1y same-signed, |pct_1y| ≥ 0.5 × cap_1y_scaled.
    #      (Rarer; e.g. mean-reversion cases where the near-term move is
    #      caught by the cap but the long-term rate stays elevated.)
    #
    # Everything else — one side clamped with the other near zero or opposite
    # direction, or a price-floor event — still floors confidence to 25.
    ev_6m = clamp_events.get('6m')
    ev_1y = clamp_events.get('1y')

    # Re-derive the (vol-scaled) per-horizon caps for the meaningful-magnitude
    # threshold. Cheaper than plumbing them through as state.
    cap_6m_scaled = 60.0 * vol_mult
    cap_1y_scaled = 85.0 * vol_mult
    pct_6m_final = result.get('predicted_change_pct_6m')
    pct_1y_final = result.get('predicted_change_pct_1y')

    coherent_direction = False
    direction: str | None = None
    coherence_reason = ''

    both_pct_clamped = (
        ev_6m and ev_1y
        and not ev_6m['price_floored'] and not ev_1y['price_floored']
        and ev_6m['pct_clamped'] and ev_1y['pct_clamped']
    )
    only_1y_pct_clamped = (
        ev_1y and ev_1y['pct_clamped'] and not ev_1y['price_floored']
        and (ev_6m is None)
    )
    only_6m_pct_clamped = (
        ev_6m and ev_6m['pct_clamped'] and not ev_6m['price_floored']
        and (ev_1y is None)
    )

    if both_pct_clamped:
        if (ev_6m['new_pct'] >= 0) == (ev_1y['new_pct'] >= 0):
            coherent_direction = True
            direction = 'up' if ev_6m['new_pct'] >= 0 else 'down'
            coherence_reason = 'both_clamped_same_sign'
    elif only_1y_pct_clamped and isinstance(pct_6m_final, (int, float)):
        same_dir = (pct_6m_final >= 0) == (ev_1y['new_pct'] >= 0)
        meaningful = abs(pct_6m_final) >= 0.5 * cap_6m_scaled
        if same_dir and meaningful:
            coherent_direction = True
            direction = 'up' if ev_1y['new_pct'] >= 0 else 'down'
            coherence_reason = f'only_1y_clamped_6m_meaningful({pct_6m_final:.1f}%)'
    elif only_6m_pct_clamped and isinstance(pct_1y_final, (int, float)):
        same_dir = (pct_1y_final >= 0) == (ev_6m['new_pct'] >= 0)
        meaningful = abs(pct_1y_final) >= 0.5 * cap_1y_scaled
        if same_dir and meaningful:
            coherent_direction = True
            direction = 'up' if ev_6m['new_pct'] >= 0 else 'down'
            coherence_reason = f'only_6m_clamped_1y_meaningful({pct_1y_final:.1f}%)'

    if coherent_direction:
        # For upside coherence, restore the model's own confidence — it's
        # genuinely extrapolating a growth signal. For downside coherence,
        # extreme bearish ceiling hits are inherently uncertain; keep at 25.
        if direction == 'up':
            if ev_6m is not None and ev_6m['original_conf'] is not None:
                result['confidence_score_6m'] = ev_6m['original_conf']
            if ev_1y is not None and ev_1y['original_conf'] is not None:
                result['confidence_score_1y'] = ev_1y['original_conf']
        else:
            result['confidence_score_6m'] = 25
            result['confidence_score_1y'] = 25
        # Ceiling flag only on the horizon(s) that actually clamped.
        if ev_6m is not None and ev_6m['pct_clamped']:
            result['at_model_ceiling_6m'] = True
        if ev_1y is not None and ev_1y['pct_clamped']:
            result['at_model_ceiling_1y'] = True
        result['ceiling_direction'] = direction
        print(f"[sanitize] {ticker} coherent {direction}-extrapolation "
              f"({coherence_reason}); "
              f"{'keeping' if direction == 'up' else 'flooring'} confidence to "
              f"(cs6m={result['confidence_score_6m']}, cs1y={result['confidence_score_1y']})",
              file=sys.stderr)
    else:
        # Outlier or inconsistent — floor confidence to 25 as before.
        if ev_6m:
            result['confidence_score_6m'] = 25
            result['confidence_reason_6m'] = (
                '6-month prediction hit the volatility-scaled ceiling but the 12-month '
                'prediction didn\'t confirm the direction with meaningful magnitude. '
                'Treated as an outlier; confidence lowered to Low.'
            )
        if ev_1y:
            result['confidence_score_1y'] = 25
            result['confidence_reason_1y'] = (
                '12-month prediction hit the volatility-scaled ceiling but the 6-month '
                'prediction didn\'t confirm the direction with meaningful magnitude. '
                'Treated as an outlier; confidence lowered to Low.'
            )

    # ── Cross-horizon consistency: 6m magnitude vs 1y ────────────────────────
    #
    # Historical behavior: when |pct_6m| > 1.5×|pct_1y| and both same-signed and
    # |pct_6m| > 15%, clamp pct_6m to 1.3×pct_1y and floor confidence to 25 on
    # the theory that "a genuine 6m move that big should persist or grow by 1y."
    #
    # False positive: this treats a legitimate peak-and-reverse trajectory
    # (ADI: raw 6m ≈ +20%, 1y ≈ +4%, then smooth decline through 2027)
    # identically to a numerically-broken 6m spike (6m = +200% out of nowhere,
    # 1y = +5%). The ratio alone can't distinguish them.
    #
    # New two-part gate:
    #   Option 2 — trajectory smoothness gate. Look at the waypoints between
    #     the 6m peak (traj[6]) and the 1y anchor (traj[12]). If the sequence
    #     is monotonic (each interior waypoint is between its neighbours), the
    #     model is deliberately forecasting peak-and-reverse — keep the raw
    #     6m target.
    #   Option 4 — moderate-confidence penalty. Whether we clamp the value or
    #     not, if the 6m and 1y magnitudes disagree by >1.5×, drop confidence
    #     to ~60 to signal "this shape is unusual." A grain of salt, not a
    #     hard 25.
    pct_6m = result.get('predicted_change_pct_6m')
    pct_1y = result.get('predicted_change_pct_1y')
    if isinstance(pct_6m, (int, float)) and isinstance(pct_1y, (int, float)):
        same_sign = (pct_6m >= 0) == (pct_1y >= 0)

        def _is_smooth_transition(traj: list, i0: int, i1: int) -> bool:
            """True if trajectory prices from index i0 to i1 (inclusive) are
            monotonic — i.e., a deliberate peak/valley + decline/rise pattern
            with no jump-back-and-forth. Requires at least 3 waypoints so a
            single-waypoint gap doesn't count as vacuously smooth."""
            if not isinstance(traj, list) or len(traj) <= i1 or i1 - i0 < 2:
                return False
            prices = []
            for k in range(i0, i1 + 1):
                wp = traj[k]
                if not isinstance(wp, dict) or 'predicted_price' not in wp:
                    return False
                prices.append(float(wp['predicted_price']))
            deltas = [prices[k + 1] - prices[k] for k in range(len(prices) - 1)]
            all_nonpos = all(d <= 1e-6 for d in deltas)
            all_nonneg = all(d >= -1e-6 for d in deltas)
            return all_nonpos or all_nonneg

        if same_sign and abs(pct_6m) > abs(pct_1y) * 1.5 and abs(pct_6m) > 15.0:
            trajectory = result.get('monthly_trajectory')
            smooth = _is_smooth_transition(trajectory, 6, 12)
            if smooth:
                # Legitimate peak-and-reverse — model is being deliberate.
                # Keep the raw 6m target; drop confidence to signal "unusual
                # shape, take the target with a grain of salt."
                cur_conf = result.get('confidence_score_6m')
                new_conf = min(int(cur_conf) if isinstance(cur_conf, (int, float)) else 60, 60)
                print(f"[sanitize] {ticker} 6m/1y ratio-disagree ({pct_6m:.1f}% vs "
                      f"{pct_1y:.1f}%) but trajectory smooth — keeping raw 6m target, "
                      f"confidence {cur_conf} → {new_conf}", file=sys.stderr)
                result['confidence_score_6m'] = new_conf
                result['confidence_reason_6m'] = (
                    f"Model predicts a cyclical peak at 6 months (+{pct_6m:.1f}%) followed by "
                    f"a decline toward the 12-month target (+{pct_1y:.1f}%). Peak-and-reverse "
                    f"forecasts are a valid but less common shape, so confidence is capped at "
                    f"Medium to signal the target should be taken with a grain of salt."
                )
            else:
                # Spike outlier — clamp the value AND drop confidence, but to
                # 60 (moderate) rather than 25 (hard floor). We still don't
                # trust the number, but we're honest that a ratio disagreement
                # isn't the same signal as a wild-price emergency.
                new_pct_6m = round(pct_1y * 1.3, 2)
                print(f"[sanitize] {ticker} 6m/1y inconsistency: pct_6m {pct_6m} vs "
                      f"pct_1y {pct_1y}, trajectory NOT smooth → pct_6m clamped to "
                      f"{new_pct_6m}, confidence → 60", file=sys.stderr)
                result['predicted_change_pct_6m'] = new_pct_6m
                if isinstance(current_price, (int, float)) and current_price > 0:
                    new_price = round(current_price * (1 + new_pct_6m / 100), 2)
                    result['predicted_price_6m'] = new_price
                    # Patch trajectory[6] so the card's Range doesn't float
                    # above the target — same fix pattern as the horizon-clamp
                    # branch does.
                    trajectory = result.get('monthly_trajectory')
                    if isinstance(trajectory, list) and len(trajectory) > 6:
                        wp = trajectory[6]
                        if isinstance(wp, dict):
                            lo, hi = wp.get('lower_bound'), wp.get('upper_bound')
                            spread = (hi - lo) if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) else 0.0
                            wp['predicted_price'] = new_price
                            wp['lower_bound']     = round(new_price - spread / 2, 2)
                            wp['upper_bound']     = round(new_price + spread / 2, 2)
                result['confidence_score_6m'] = 60
                result['confidence_reason_6m'] = (
                    f"6-month prediction disagreed sharply with the 12-month prediction "
                    f"(6m raw was much larger than 1y). The 6-month target was pulled toward "
                    f"the 1-year trajectory and confidence lowered to Medium."
                )
        elif not same_sign and abs(pct_6m) > 5.0 and abs(pct_1y) > 5.0:
            # Opposite-sign disagreement above noise floor: treat the 6m head as the
            # outlier and pull it onto the glide path toward the 1y target.
            new_pct_6m = round(pct_1y * 0.5, 2)
            print(f"[sanitize] {ticker} 6m/1y opposite-sign: pct_6m {pct_6m} vs pct_1y {pct_1y} "
                  f"→ pct_6m glide-pathed to {new_pct_6m}", file=sys.stderr)
            result['predicted_change_pct_6m'] = new_pct_6m
            if isinstance(current_price, (int, float)) and current_price > 0:
                new_price = round(current_price * (1 + new_pct_6m / 100), 2)
                result['predicted_price_6m'] = new_price
                trajectory = result.get('monthly_trajectory')
                if isinstance(trajectory, list) and len(trajectory) > 6:
                    wp = trajectory[6]
                    if isinstance(wp, dict):
                        lo, hi = wp.get('lower_bound'), wp.get('upper_bound')
                        spread = (hi - lo) if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) else 0.0
                        wp['predicted_price'] = new_price
                        wp['lower_bound']     = round(new_price - spread / 2, 2)
                        wp['upper_bound']     = round(new_price + spread / 2, 2)
            result['confidence_score_6m'] = 25
            result['confidence_reason_6m'] = (
                "6-month prediction disagreed with 12-month on direction (one bullish, one "
                "bearish). The 6-month target was pulled onto the glide path toward the "
                "1-year target and confidence lowered to Low."
            )

    # ── Cross-horizon coherence: 1m vs 6m spike-then-crash check ────────────
    # Catches the CS short-term / long-term model divergence pattern where the
    # 1m model predicts a large gain but the 6m model predicts a large loss
    # (or vice versa). The resulting spike-then-crash trajectory is not a
    # plausible forecast — it implies a complete reversal in 4 weeks with no
    # fundamental justification. Glide-path 1m to the linear interpolation
    # between 1w and 6m so the trajectory is monotonic.
    pct_1w_final = result.get('predicted_change_pct_1w')
    pct_1m_final = result.get('predicted_change_pct_1m')
    pct_6m_final_check = result.get('predicted_change_pct_6m')
    if (isinstance(pct_1w_final, (int, float))
            and isinstance(pct_1m_final, (int, float))
            and isinstance(pct_6m_final_check, (int, float))):
        _opposite_signs = (pct_1m_final >= 0) != (pct_6m_final_check >= 0)
        _both_big = abs(pct_1m_final) > 8.0 and abs(pct_6m_final_check) > 8.0
        # Also catch same-sign spike where 1m is 2.5x larger than 6m magnitude
        # (e.g. 1m=+50%, 6m=+15% → hard to sustain; model is extrapolating).
        _same_sign_spike = (
            not _opposite_signs
            and abs(pct_1m_final) > abs(pct_6m_final_check) * 2.5
            and abs(pct_1m_final) > 20.0
        )
        if (_opposite_signs and _both_big) or _same_sign_spike:
            # Linear interpolation from 1w (t=5) to 6m (t=126) at t=21
            t_norm = (21 - 5) / (126 - 5)
            new_pct_1m = round(pct_1w_final + (pct_6m_final_check - pct_1w_final) * t_norm, 2)
            print(
                f"[sanitize] {ticker} 1m/6m incoherence "
                f"(1m={pct_1m_final:.1f}%, 6m={pct_6m_final_check:.1f}%) "
                f"→ glide-pathed to {new_pct_1m:.1f}%",
                file=sys.stderr,
            )
            result['predicted_change_pct_1m'] = new_pct_1m
            if isinstance(current_price, (int, float)) and current_price > 0:
                new_price_1m = round(current_price * (1 + new_pct_1m / 100), 2)
                result['predicted_price_1m'] = new_price_1m
                trajectory = result.get('monthly_trajectory')
                if isinstance(trajectory, list) and len(trajectory) > 1:
                    wp = trajectory[1]
                    if isinstance(wp, dict):
                        lo = wp.get('lower_bound')
                        hi = wp.get('upper_bound')
                        spread = (hi - lo) if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) else 0.0
                        wp['predicted_price'] = new_price_1m
                        wp['lower_bound'] = round(new_price_1m - spread / 2, 2)
                        wp['upper_bound'] = round(new_price_1m + spread / 2, 2)
            # Moderate confidence (floor at 50 when the prior clamp already set
            # a lower value, keep the lower). Glide-path is a reasonable
            # estimate but model disagreement signals genuine uncertainty.
            cur_cs_1m = result.get('confidence_score_1m')
            new_cs_1m = min(int(cur_cs_1m) if isinstance(cur_cs_1m, (int, float)) else 50, 50)
            result['confidence_score_1m'] = new_cs_1m
            result['confidence_reason_1m'] = (
                f"1-month prediction ({pct_1m_final:+.1f}%) was incoherent with the "
                f"6-month prediction ({pct_6m_final_check:+.1f}%). The 1-month target "
                f"was interpolated along the trajectory between the 1-week and 6-month "
                f"anchors. Confidence lowered to {'Low' if new_cs_1m <= 30 else 'Medium'}."
            )

    return result
