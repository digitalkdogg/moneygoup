#!/usr/bin/env python3
"""
test_analyst_sentiment.py — standalone tests for compute_analyst_sentiment().

Mirrors test_sanitize_predictions.py's flat-file pattern (no pytest dep).
Each function asserts and the bottom of the file invokes them.

Run:
    python3 scripts/test_analyst_sentiment.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analyst_sentiment import (
    compute_analyst_sentiment,
    compute_rec_score,
    compute_target_score,
    compute_dispersion_penalty,
)


def _hist(*rows):
    """Helper: build a recommendations_history list from positional dicts."""
    return list(rows)


# ── Part A — RecScore ────────────────────────────────────────────────────────

def test_recscore_neutral_no_data():
    score, n = compute_rec_score([])
    assert score == 50.0
    assert n == 0.0


def test_recscore_unanimous_strong_buy():
    history = [{'period': '0m', 'strongBuy': 10, 'buy': 0, 'hold': 0, 'sell': 0, 'strongSell': 0}]
    score, n = compute_rec_score(history)
    assert score == 100.0, score
    assert n == 10


def test_recscore_unanimous_strong_sell():
    history = [{'period': '0m', 'strongBuy': 0, 'buy': 0, 'hold': 0, 'sell': 0, 'strongSell': 10}]
    score, n = compute_rec_score(history)
    assert score == 0.0, score


def test_recscore_all_hold_is_neutral():
    history = [{'period': '0m', 'strongBuy': 0, 'buy': 0, 'hold': 10, 'sell': 0, 'strongSell': 0}]
    score, _ = compute_rec_score(history)
    # All-Hold → S=0 → RecScore=50 (anchored at S=0)
    assert score == 50.0, score


def test_recscore_user_example_bearish_skew():
    # 1 SB, 1 B, 0 H, 1 S, 3 SS → S = (2 + 1 + 0 - 1.5 - 9)/6 = -7.5/6 = -1.25
    # RecScore = 50 + (-1.25/3)*50 = 50 - 20.83 = 29.17
    history = [{'period': '0m', 'strongBuy': 1, 'buy': 1, 'hold': 0, 'sell': 1, 'strongSell': 3}]
    score, _ = compute_rec_score(history)
    assert 29.0 <= score <= 29.5, score


def test_recscore_single_strong_sell_dents_otherwise_bullish():
    # Option α: 1 SS in a sea of 9 buys hits harder than v1 symmetric would
    history = [{'period': '0m', 'strongBuy': 5, 'buy': 4, 'hold': 0, 'sell': 0, 'strongSell': 1}]
    # S = (10 + 4 + 0 + 0 - 3)/10 = +1.1 → RecScore = 50 + (1.1/2)*50 = 77.5
    score, _ = compute_rec_score(history)
    assert 77.0 <= score <= 78.0, score


def test_recscore_time_weighted_recency():
    # Bullish 0m, neutral history → score should reflect current more than history
    history = [
        {'period': '0m',  'strongBuy': 10, 'buy': 0, 'hold': 0, 'sell': 0, 'strongSell': 0},  # +100
        {'period': '-1m', 'strongBuy': 0,  'buy': 0, 'hold': 10, 'sell': 0, 'strongSell': 0}, # neutral
        {'period': '-2m', 'strongBuy': 0,  'buy': 0, 'hold': 10, 'sell': 0, 'strongSell': 0},
        {'period': '-3m', 'strongBuy': 0,  'buy': 0, 'hold': 10, 'sell': 0, 'strongSell': 0},
    ]
    score, _ = compute_rec_score(history)
    # 0.45 weight on +2, rest neutral → raw = 0.45*2 = 0.9
    # RecScore = 50 + (0.9/2)*50 = 72.5
    assert 72.0 <= score <= 73.0, score


def test_recscore_renormalizes_missing_periods():
    # Only 0m present → its weight should normalize to 1.0
    history = [{'period': '0m', 'strongBuy': 10, 'buy': 0, 'hold': 0, 'sell': 0, 'strongSell': 0}]
    score, _ = compute_rec_score(history)
    # Should be full +100 (not 50 + 0.45*50 = 72.5)
    assert score == 100.0, score


# ── Part B — TargetScore ────────────────────────────────────────────────────

def test_targetscore_neutral_when_no_data():
    assert compute_target_score(None, 100.0) == 50.0
    assert compute_target_score(100.0, 0) == 50.0
    assert compute_target_score(100.0, None) == 50.0


def test_targetscore_at_cap_upside():
    # +30% upside hits the +50 swing → score 100
    assert compute_target_score(130.0, 100.0) == 100.0


def test_targetscore_at_cap_downside():
    # -30% upside → score 0
    assert compute_target_score(70.0, 100.0) == 0.0


def test_targetscore_beyond_cap_clamped():
    # +50% upside → still 100 (cap)
    assert compute_target_score(150.0, 100.0) == 100.0


def test_targetscore_midpoint():
    # +15% upside → 50 + (15/30)*50 = 75
    assert compute_target_score(115.0, 100.0) == 75.0


# ── Dispersion penalty ──────────────────────────────────────────────────────

def test_dispersion_penalty_no_data():
    assert compute_dispersion_penalty(None, None, None) == 0.0
    assert compute_dispersion_penalty(80, None, 100) == 0.0


def test_dispersion_penalty_tight_spread():
    # 5% spread → 0.05 penalty
    p = compute_dispersion_penalty(95.0, 100.0, 97.5)
    assert abs(p - 0.0513) < 0.001, p


def test_dispersion_penalty_capped_at_15pct():
    # 100% spread → capped at 0.15
    p = compute_dispersion_penalty(50.0, 150.0, 100.0)
    assert p == 0.15, p


# ── Composite — compute_analyst_sentiment ───────────────────────────────────

def test_full_unanimous_buy_high_coverage():
    history = [
        {'period': '0m',  'strongBuy': 25, 'buy': 0, 'hold': 0, 'sell': 0, 'strongSell': 0},
        {'period': '-1m', 'strongBuy': 25, 'buy': 0, 'hold': 0, 'sell': 0, 'strongSell': 0},
    ]
    out = compute_analyst_sentiment(history, target_mean=130.0, target_low=125.0,
                                    target_high=135.0, current_price=100.0)
    assert out['rec_score'] == 100.0
    assert out['target_score'] == 100.0
    assert out['final_score'] == 100.0
    # analyst_impact = +0.10 × reliability(25/40=0.625) × (1-dispersion)
    # dispersion = 10/130 ≈ 0.077
    expected = 0.10 * 0.625 * (1 - 0.0769)
    assert abs(out['analyst_impact'] - expected) < 0.005, out['analyst_impact']
    assert out['coverage_pts'] == 8        # >=20 analysts
    assert out['conviction_pts'] == 6      # |100-50|/50 * 7 = 7 × (1 - 0.077) ≈ 6.5 → 6


def test_full_bearish_low_coverage():
    # 5 analysts unanimous strong sell, no target data
    history = [{'period': '0m', 'strongBuy': 0, 'buy': 0, 'hold': 0, 'sell': 0, 'strongSell': 5}]
    out = compute_analyst_sentiment(history, target_mean=None, target_low=None,
                                    target_high=None, current_price=100.0)
    assert out['rec_score'] == 0.0
    assert out['target_score'] == 50.0   # no target data → neutral
    # FinalScore = 0.6 × 0 + 0.4 × 50 = 20
    assert out['final_score'] == 20.0
    # analyst_impact = (20-50)/50 × 0.10 = -0.06; × reliability(5/40=0.125) × (1-0) = -0.0075
    assert abs(out['analyst_impact'] - (-0.0075)) < 0.001, out['analyst_impact']
    assert out['coverage_pts'] == 4      # 3-9 analysts
    assert out['conviction_pts'] == 4    # |20-50|/50 × 7 = 4.2 → 4


def test_empty_history_returns_neutral():
    out = compute_analyst_sentiment(None, 100.0, 90.0, 110.0, 100.0)
    assert out['final_score'] == 50.0
    assert out['analyst_impact'] == 0.0
    assert out['coverage_pts'] == 0
    assert out['conviction_pts'] == 0


def test_low_coverage_below_floor():
    # 2 analysts — coverage_pts should be 0
    history = [{'period': '0m', 'strongBuy': 1, 'buy': 1, 'hold': 0, 'sell': 0, 'strongSell': 0}]
    out = compute_analyst_sentiment(history, 120.0, 110.0, 130.0, 100.0)
    assert out['coverage_pts'] == 0, out['coverage_pts']


def test_rtx_realistic_scenario():
    # Match the trace I ran on RTX earlier: 22 analysts, leaning Buy
    history = [
        {'period': '0m',  'strongBuy': 4, 'buy': 11, 'hold': 8, 'sell': 0, 'strongSell': 0},
        {'period': '-1m', 'strongBuy': 5, 'buy': 10, 'hold': 8, 'sell': 0, 'strongSell': 0},
        {'period': '-2m', 'strongBuy': 5, 'buy': 10, 'hold': 7, 'sell': 1, 'strongSell': 0},
        {'period': '-3m', 'strongBuy': 4, 'buy': 9,  'hold': 7, 'sell': 2, 'strongSell': 1},
    ]
    out = compute_analyst_sentiment(history, target_mean=215.73, target_low=180.0,
                                    target_high=242.0, current_price=188.0)
    # Smoke-check bounds
    assert 60.0 < out['rec_score'] < 80.0, out['rec_score']      # leaning bullish, modest
    assert 70.0 < out['target_score'] < 80.0, out['target_score'] # +14.75% upside
    assert 65.0 < out['final_score'] < 78.0, out['final_score']
    # Reliability ~ 22/40 = 0.55, so analyst_impact ~ +0.03 × 0.55 × (1 - dispersion)
    assert 0.005 < out['analyst_impact'] < 0.04, out['analyst_impact']
    assert out['coverage_pts'] == 8    # >=20 average
    assert out['conviction_pts'] > 0   # some lean
    print(f"  [rtx-trace] final_score={out['final_score']}, analyst_impact={out['analyst_impact']:.4f}, "
          f"coverage_pts={out['coverage_pts']}, conviction_pts={out['conviction_pts']}, "
          f"dispersion={out['dispersion_penalty']:.3f}")


def test_dispersion_mutes_lift_and_conviction():
    # Same panel as RTX but with crazy-wide spread → expect bigger penalty
    history = [{'period': '0m', 'strongBuy': 5, 'buy': 5, 'hold': 0, 'sell': 0, 'strongSell': 0}]
    narrow = compute_analyst_sentiment(history, target_mean=100, target_low=95, target_high=105,
                                       current_price=80)
    wide   = compute_analyst_sentiment(history, target_mean=100, target_low=50, target_high=150,
                                       current_price=80)
    assert wide['analyst_impact'] < narrow['analyst_impact'], \
        f"wide={wide['analyst_impact']} narrow={narrow['analyst_impact']}"
    assert wide['conviction_pts'] <= narrow['conviction_pts']


def main():
    tests = [
        test_recscore_neutral_no_data,
        test_recscore_unanimous_strong_buy,
        test_recscore_unanimous_strong_sell,
        test_recscore_all_hold_is_neutral,
        test_recscore_user_example_bearish_skew,
        test_recscore_single_strong_sell_dents_otherwise_bullish,
        test_recscore_time_weighted_recency,
        test_recscore_renormalizes_missing_periods,
        test_targetscore_neutral_when_no_data,
        test_targetscore_at_cap_upside,
        test_targetscore_at_cap_downside,
        test_targetscore_beyond_cap_clamped,
        test_targetscore_midpoint,
        test_dispersion_penalty_no_data,
        test_dispersion_penalty_tight_spread,
        test_dispersion_penalty_capped_at_15pct,
        test_full_unanimous_buy_high_coverage,
        test_full_bearish_low_coverage,
        test_empty_history_returns_neutral,
        test_low_coverage_below_floor,
        test_rtx_realistic_scenario,
        test_dispersion_mutes_lift_and_conviction,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {t.__name__}: {exc}")
        except Exception as exc:
            failed += 1
            print(f"  ERROR {t.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
