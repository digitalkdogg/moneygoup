"""
analyst_sentiment.py — v2 analyst sentiment scoring.

Composes a 0-100 FinalScore from time-weighted recommendation history +
price target sentiment. Asymmetric rating weights (sells weighted heavier
than buys), reliability dampening for low-coverage stocks, and dispersion
penalty for analyst disagreement on target prices.

Plugs into metric_analysis() in predict_core.py as the analyst_impact
input when ANALYST_SCORING_VERSION='v2'; legacy consensus_value +
analyst_weighted path stays available for fallback.

Reference design (matches the discussion in the prediction_workflow doc):
  Part A: time-weighted RecScore (asymmetric weights, anchored S=0 → 50)
  Part B: TargetScore (upside %, capped at ±30%)
  Combine: FinalScore = 0.6 × RecScore + 0.4 × TargetScore
  Modifiers: reliability dampening + dispersion penalty
"""
from __future__ import annotations

import math

# ── Constants ────────────────────────────────────────────────────────────────

# Recency weights for the 4-period history (yfinance Ticker.recommendations).
# 0m = current snapshot; -1m / -2m / -3m = 1/2/3 months ago.
RECENCY_WEIGHTS = {'0m': 0.45, '-1m': 0.28, '-2m': 0.17, '-3m': 0.10}

# Option α — asymmetric rating weights. Sells weighted 1.5× harder than buys
# so a single Strong Sell in an otherwise-bullish panel meaningfully dents
# the score (motivation: sell-side analysts rarely issue sell ratings; when
# they do, the signal is unusually informative).
RATING_WEIGHTS = {
    'strongBuy':  2.0,
    'buy':        1.0,
    'hold':       0.0,
    'sell':      -1.5,
    'strongSell': -3.0,
}
RATING_MAX = 2.0    # max positive S(t)
RATING_MIN = -3.0   # max negative S(t)

# Mapping FinalScore → analyst_impact (signed). At 100 → +0.15, at 0 → -0.15.
# Combined with per-horizon boosts (0.25/0.83/1.67) in predict_short_term and
# predict_long_term, this gives max lifts of +3.75% / +12.5% / +25%.
MAX_ANALYST_IMPACT = 0.15

# Reliability dampening — applied AFTER FinalScore. Saturates at 40 analysts.
# Floor + sqrt curve: reliability = FLOOR + (1-FLOOR) × sqrt(min(n/40, 1)).
# At n=4 → ~74%, n=20 → ~92%, n=40+ → 100%.  Replaces the old linear ramp
# (n/40) which gave n=4 → 10%, a punishing 10× gap vs deep-coverage stocks.
RELIABILITY_SATURATION = 40
RELIABILITY_FLOOR = 0.60

# Confidence score components (new — replaces v1's flat 15-pt analyst block).
COVERAGE_PTS_MAX   = 8   # max pts from analyst count
CONVICTION_PTS_MAX = 7   # max pts from |FinalScore − 50|
# Sum 15 — same as v1's analyst-coverage component to keep scale consistent.

# Dispersion penalty cap. (target_high - target_low) / target_mean × 100 → %.
# A spread of 100% (e.g. low=$80, high=$160, mean=$80) hits the cap.
DISPERSION_PENALTY_CAP = 0.15


# ── Computation helpers ──────────────────────────────────────────────────────

def _compute_period_score(period_counts: dict) -> tuple[float, int]:
    """Returns (S_t, total_count) for one period.
    Returns (0.0, 0) if no analysts in this period (caller treats as "skip")."""
    sb = float(period_counts.get('strongBuy', 0) or 0)
    b  = float(period_counts.get('buy', 0) or 0)
    h  = float(period_counts.get('hold', 0) or 0)
    s  = float(period_counts.get('sell', 0) or 0)
    ss = float(period_counts.get('strongSell', 0) or 0)
    n = sb + b + h + s + ss
    if n <= 0:
        return 0.0, 0
    weighted = (sb * RATING_WEIGHTS['strongBuy']
                + b * RATING_WEIGHTS['buy']
                + h * RATING_WEIGHTS['hold']
                + s * RATING_WEIGHTS['sell']
                + ss * RATING_WEIGHTS['strongSell'])
    return weighted / n, int(n)


def compute_rec_score(history: list[dict]) -> tuple[float, float]:
    """Part A — time-weighted RecScore (0-100), with asymmetric weights.

    Args:
        history: list of dicts with keys ['period', 'strongBuy', 'buy', 'hold',
                 'sell', 'strongSell']. Period values: '0m', '-1m', '-2m', '-3m'.

    Returns:
        (rec_score, avg_analyst_count_per_period)
    """
    raw = 0.0
    weight_used = 0.0
    counts_seen = []
    for row in history:
        period = str(row.get('period', '')).strip()
        if period not in RECENCY_WEIGHTS:
            continue
        s_t, n = _compute_period_score(row)
        if n == 0:
            continue
        raw += RECENCY_WEIGHTS[period] * s_t
        weight_used += RECENCY_WEIGHTS[period]
        counts_seen.append(n)

    if weight_used <= 0 or not counts_seen:
        return 50.0, 0.0   # neutral fallback when no data

    raw /= weight_used     # renormalize for any missing periods

    # Asymmetric → 0..100 mapping, anchored at S=0 → 50.
    # Each direction scaled independently so an "all-Hold" panel (S=0) still
    # maps to a true-neutral 50.
    if raw >= 0:
        rec_score = 50.0 + (raw / RATING_MAX) * 50.0
    else:
        rec_score = 50.0 + (raw / abs(RATING_MIN)) * 50.0

    rec_score = max(0.0, min(100.0, rec_score))
    avg_count = sum(counts_seen) / len(counts_seen)
    return rec_score, avg_count


def compute_target_score(target_mean: float, current_price: float) -> float:
    """Part B — TargetScore (0-100) from upside %, capped at ±30%."""
    if current_price is None or current_price <= 0:
        return 50.0
    if target_mean is None or target_mean <= 0:
        return 50.0
    upside_pct = ((target_mean - current_price) / current_price) * 100.0
    score = 50.0 + (upside_pct / 30.0) * 50.0
    return max(0.0, min(100.0, score))


def compute_dispersion_penalty(
    target_low: float | None,
    target_high: float | None,
    target_mean: float | None,
) -> float:
    """Spread-of-targets penalty in [0, 0.15]. Wider spread = more analyst
    disagreement = less confidence in the consensus."""
    if not (target_low and target_high and target_mean):
        return 0.0
    if target_mean <= 0:
        return 0.0
    spread_pct = ((float(target_high) - float(target_low)) / float(target_mean)) * 100.0
    if spread_pct < 0:
        return 0.0
    return min(spread_pct / 100.0, DISPERSION_PENALTY_CAP)


def _coverage_pts(avg_count: float) -> int:
    """Coverage half of the 15-pt confidence component. 0-8 pts."""
    if avg_count >= 20: return COVERAGE_PTS_MAX
    if avg_count >= 10: return 6
    if avg_count >= 3:  return 4
    return 0   # <3 analysts: no coverage credit


def _conviction_pts(final_score: float) -> int:
    """Conviction half of the 15-pt confidence component. 0-7 pts.
    Decisive scores (close to 0 or 100) get more credit than neutral."""
    deviation = abs(final_score - 50.0)
    raw = (deviation / 50.0) * CONVICTION_PTS_MAX
    return int(round(max(0.0, min(float(CONVICTION_PTS_MAX), raw))))


# ── Main entrypoint ──────────────────────────────────────────────────────────

def compute_analyst_sentiment(
    recommendations_history: list[dict] | None,
    target_mean: float | None,
    target_low: float | None,
    target_high: float | None,
    current_price: float,
) -> dict:
    """Compute v2 analyst sentiment from yfinance-format inputs.

    Args:
        recommendations_history: list of period rows from yfinance
            Ticker.recommendations (with 'period' key in {'0m','-1m','-2m','-3m'}).
            None or empty → graceful neutral fallback.
        target_mean: yfinance targetMeanPrice. None → skip Part B.
        target_low, target_high: yfinance targetLow/HighPrice. None → skip dispersion penalty.
        current_price: regularMarketPrice. Required (used for Part B upside %).

    Returns dict with:
        final_score (0-100)
        rec_score   (0-100, Part A)
        target_score (0-100, Part B)
        analyst_impact (signed, after reliability dampening + dispersion penalty)
        coverage_pts   (0-8)
        conviction_pts (0-7)
        dispersion_penalty (0-0.15)
        avg_analyst_count (mean N per period across history)
    """
    if not recommendations_history:
        return {
            'final_score': 50.0,
            'rec_score': 50.0,
            'target_score': 50.0,
            'analyst_impact': 0.0,
            'coverage_pts': 0,
            'conviction_pts': 0,
            'dispersion_penalty': 0.0,
            'avg_analyst_count': 0.0,
        }

    rec_score,  avg_count   = compute_rec_score(recommendations_history)
    target_score            = compute_target_score(target_mean, current_price)
    dispersion              = compute_dispersion_penalty(target_low, target_high, target_mean)

    # Part C — combine. Ratings carry slightly more weight than price targets
    # because targets can lag (analysts are slow to update them).
    final_score = 0.6 * rec_score + 0.4 * target_score

    # FinalScore → signed analyst_impact (range -MAX..+MAX before modifiers).
    normalized = (final_score - 50.0) / 50.0
    analyst_impact = normalized * MAX_ANALYST_IMPACT

    # Reliability dampening: low-coverage stocks shouldn't move predictions
    # as much as deep-coverage ones, even when Part A normalization gives
    # them the same RecScore.  Floor + sqrt curve keeps thin-coverage stocks
    # in the game (~74% weight at 4 analysts) instead of the old linear ramp
    # that gave them only ~10% weight (a punishing 10× gap vs 40-analyst stocks).
    reliability = RELIABILITY_FLOOR + (1.0 - RELIABILITY_FLOOR) * math.sqrt(
        min(avg_count / RELIABILITY_SATURATION, 1.0)
    )
    analyst_impact *= reliability

    # Dispersion penalty: wide-spread analyst panels mute both the prediction
    # lift AND the confidence credit.
    analyst_impact *= (1.0 - dispersion)

    # Confidence-score points (replaces v1's count-based 15-pt block).
    coverage   = _coverage_pts(avg_count)
    conviction = _conviction_pts(final_score)
    conviction = int(round(conviction * (1.0 - dispersion)))

    return {
        'final_score':        round(float(final_score), 1),
        'rec_score':          round(float(rec_score), 1),
        'target_score':       round(float(target_score), 1),
        'analyst_impact':     float(analyst_impact),
        'coverage_pts':       int(coverage),
        'conviction_pts':     int(conviction),
        'dispersion_penalty': round(float(dispersion), 3),
        'avg_analyst_count':  float(avg_count),
    }
