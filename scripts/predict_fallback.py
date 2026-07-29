"""
predict_fallback.py — Statistical fallback model.

Used when the full ML pipeline (predict_weighted_analysis.py) fails.
Requires no TensorFlow / Keras — pure NumPy.

Computes predictions from linear-regression trend + momentum with
time-decay-weighted news sentiment.  Returns the same JSON schema as
the main model so callers need no special-case logic beyond checking
`model_mode == 'fallback'`.

CLI:
    python3 predict_fallback.py <ticker> --input_file <path> [--outlook <outlook>]
"""

import sys
import json
import argparse
import os

os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'

import numpy as np
from datetime import datetime

# Confidence is deliberately capped below the full model so users know
# the fallback is less reliable.
MAX_CONF_PCT    = 65
MIN_DAYS        = 30
SENTIMENT_SCALE = 0.015   # mirrors predict_core metric_analysis coefficient


def _rsi(closes: np.ndarray, period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(closes[-(period + 1):])
    gains  = float(np.where(deltas > 0, deltas, 0.0).mean())
    losses = float(np.where(deltas < 0, -deltas, 0.0).mean())
    if losses < 1e-10:
        return 100.0
    return 100.0 - (100.0 / (1.0 + gains / losses))


def _news_sentiment(news_articles: list) -> float:
    """Mirrors predict_core.calculate_news_sentiment — sign-vote + time decay."""
    LEXICON = {
        'beat': 3, 'beats': 3, 'surge': 3, 'growth': 2, 'bullish': 3,
        'bearish': -3, 'upgrade': 3, 'downgrade': -3, 'soars': 3, 'rally': 3,
        'plunges': -3, 'tumbles': -3, 'outperform': 3, 'underperform': -3,
        'buy': 2, 'sell': -2, 'profit': 2, 'loss': -2, 'miss': -3, 'misses': -3,
    }
    score = count = 0.0
    for a in news_articles:
        text = f"{a.get('title', '')} {a.get('description', '')}".lower()
        art_score = sum(LEXICON.get(w.strip('.,!?'), 0) for w in text.split())
        orig = a.get('sentiment_score')
        if orig is not None:
            art_score += float(orig)
        pub = a.get('publishedAt') or a.get('pubDate')
        weight = 1.0
        if pub:
            try:
                dt = datetime.fromisoformat(str(pub).replace('Z', '+00:00'))
                age_days = (datetime.now(dt.tzinfo) - dt).days
                weight = max(0.1, 1.0 - age_days / 30.0)
            except Exception:
                pass
        if art_score != 0:
            score += (1 if art_score > 0 else -1) * weight
            count += weight
    if count == 0:
        return 0.0
    return float(np.tanh(score / count))


def predict_fallback(ticker: str, input_data: dict, outlook: str = 'all') -> dict:
    historical    = input_data.get('historicalData', [])
    news_articles = input_data.get('newsArticles', [])

    closes_raw = [
        float(d['close']) for d in historical
        if d.get('close') is not None and float(d['close']) > 0
    ]
    if len(closes_raw) < MIN_DAYS:
        raise ValueError(
            f"Insufficient data: {len(closes_raw)} days (minimum {MIN_DAYS} required for fallback model)"
        )

    closes = np.array(closes_raw[-252:])
    n = len(closes)
    current_price = float(closes[-1])

    # Linear-regression trend
    x = np.arange(n, dtype=float)
    coef = np.polyfit(x, closes, 1)
    trend_pct_per_day = float(coef[0]) / current_price

    # Short/medium momentum factors
    mom20 = (closes[-1] / closes[-20] - 1.0) / 20.0 if n >= 20 else trend_pct_per_day
    mom50 = (closes[-1] / closes[-50] - 1.0) / 50.0 if n >= 50 else mom20

    # 50% LR trend, 30% 20d momentum, 20% 50d momentum
    trend_blend = 0.5 * trend_pct_per_day + 0.3 * mom20 + 0.2 * mom50

    rsi       = _rsi(closes)
    sentiment = _news_sentiment(news_articles)

    # Forward projections with dampening (prevents wild linear extrapolation)
    def project(days: int, dampening: float = 0.0) -> float:
        raw = trend_blend * days + sentiment * SENTIMENT_SCALE
        if dampening > 0:
            raw *= max(0.0, 1.0 - dampening * (days / 252.0))
        return float(np.clip(raw, -0.60, 0.60))

    pct_1w = project(5)
    pct_1m = project(21)
    pct_6m = project(126, dampening=0.50)
    pct_1y = project(252, dampening=0.65)

    # Confidence — capped at MAX_CONF_PCT, reduced for RSI extremes and sparse data
    data_factor = min(1.0, n / 252.0)
    rsi_penalty = 0.10 if (rsi > 70 or rsi < 30) else 0.0
    base_conf   = MAX_CONF_PCT * data_factor * (1.0 - rsi_penalty)

    conf_1w = max(20, round(base_conf * 0.95))
    conf_1m = max(20, round(base_conf * 0.85))
    conf_6m = max(15, round(base_conf * 0.65))
    conf_1y = max(15, round(base_conf * 0.50))

    def direction(pct: float) -> str:
        if pct > 0.01:  return 'up'
        if pct < -0.01: return 'down'
        return 'neutral'

    return {
        'model_mode':              'fallback',
        'model_status':            'fallback_statistical',
        'current_price':           round(current_price, 4),
        'predicted_price_1w':      round(current_price * (1.0 + pct_1w), 4),
        'predicted_price_1m':      round(current_price * (1.0 + pct_1m), 4),
        'predicted_price_6m':      round(current_price * (1.0 + pct_6m), 4),
        'predicted_price_1y':      round(current_price * (1.0 + pct_1y), 4),
        'predicted_change_pct_1w': round(pct_1w * 100.0, 2),
        'predicted_change_pct_1m': round(pct_1m * 100.0, 2),
        'predicted_change_pct_6m': round(pct_6m * 100.0, 2),
        'predicted_change_pct_1y': round(pct_1y * 100.0, 2),
        'predicted_direction_1w':  direction(pct_1w),
        'predicted_direction_1m':  direction(pct_1m),
        'predicted_direction_6m':  direction(pct_6m),
        'predicted_direction_1y':  direction(pct_1y),
        'confidence_score_1w':     conf_1w,
        'confidence_score_1m':     conf_1m,
        'confidence_score_6m':     conf_6m,
        'confidence_score_1y':     conf_1y,
        'news_sentiment_score':    round(float(sentiment), 4),
        'rsi':                     round(float(rsi), 2),
        'high_uncertainty':        False,
        'monthly_trajectory':      [],
        'predicted_change_range':  [
            round(pct_1y * 100.0 * 0.7, 2),
            round(pct_1y * 100.0 * 1.3, 2),
        ],
        'accuracy_metrics':        {},
        'data_quality': {
            'historyDays':          n,
            'historyYears':         round(n / 252.0, 1),
            'fundamentalsComplete': False,
            'analystDataAvailable': False,
            'imputedFields':        [],
        },
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Statistical fallback prediction model')
    parser.add_argument('ticker')
    parser.add_argument('--input_file', required=True)
    parser.add_argument('--outlook',    default='all')
    args = parser.parse_args()

    try:
        with open(args.input_file) as f:
            input_data = json.load(f)

        result = predict_fallback(args.ticker, input_data, args.outlook)
        print(json.dumps(result))
        sys.exit(0)

    except Exception as exc:
        import traceback
        print(
            json.dumps({'error': str(exc), 'traceback': traceback.format_exc()}),
            file=sys.stderr,
        )
        sys.exit(1)
