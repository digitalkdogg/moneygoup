#!/usr/bin/env python3
"""
test_sanitize_predictions.py — standalone tests for _sanitize_predictions().

Run directly:
    python3 scripts/test_sanitize_predictions.py

Mirrors the flat-file pattern of scripts/test_feature_columns.py (no pytest
dependency; each function asserts and the bottom of the file invokes them).
"""
import math
import os
import sys

# Allow running from anywhere
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Bounds computed from _sanitize_predictions internals (Z_CAP=3.0, vol=0.30 default)
_1W_BOUND = max(7.0,  3.0 * 0.30 * math.sqrt(5   / 252) * 100)  # ~12.68%
_1M_BOUND = max(12.0, 3.0 * 0.30 * math.sqrt(21  / 252) * 100)  # ~25.98%
_3M_BOUND = max(20.0, 3.0 * 0.30 * math.sqrt(63  / 252) * 100)  # exactly 45.0%
_6M_BOUND = max(30.0, 3.0 * 0.30 * math.sqrt(126 / 252) * 100)  # ~63.64%

from predict_core import _sanitize_predictions


def _base(**overrides):
    """A minimal valid prediction result. Tests merge their fields in."""
    base = {
        'ticker': 'TEST',
        'regularMarketPrice': 100.0,
        'predicted_price_1w':  101.0, 'predicted_change_pct_1w':  1.0, 'confidence_score_1w': 70,
        'predicted_price_1m':  103.0, 'predicted_change_pct_1m':  3.0, 'confidence_score_1m': 70,
        'predicted_price_3m':  107.0, 'predicted_change_pct_3m':  7.0, 'confidence_score_3m': 70,
        'predicted_price_6m':  110.0, 'predicted_change_pct_6m': 10.0, 'confidence_score_6m': 65,
    }
    base.update(overrides)
    return base


def test_legitimate_prediction_unchanged():
    r = _sanitize_predictions(_base())
    assert r['predicted_change_pct_3m'] == 7.0
    assert r['predicted_price_3m'] == 107.0
    assert r['confidence_score_3m'] == 70


def test_overshoot_3m_vs_6m_clamps_and_lowers_confidence():
    # 3m=23.8, 6m=8.2 → ratio 2.92, floor 15% → fires
    r = _sanitize_predictions(_base(
        regularMarketPrice=67.30,
        predicted_price_3m=83.32, predicted_change_pct_3m=23.8,
        predicted_price_6m=72.82, predicted_change_pct_6m=8.2,
    ))
    # pct_3m should be clamped to 1.3 × pct_6m = 10.66
    assert r['predicted_change_pct_3m'] == 10.66, r['predicted_change_pct_3m']
    # price should follow: 67.30 * 1.1066 = 74.47
    assert r['predicted_price_3m'] == 74.47, r['predicted_price_3m']
    # confidence dropped to moderate
    assert r['confidence_score_3m'] == 60


def test_negative_overshoot_also_clamps():
    # PFE-style: pct_3m=-16.22, pct_6m=-7.14 → ratio 2.27, fires on bearish side
    r = _sanitize_predictions(_base(
        regularMarketPrice=24.02,
        predicted_price_3m=20.12, predicted_change_pct_3m=-16.22,
        predicted_price_6m=22.31, predicted_change_pct_6m=-7.14,
    ))
    expected_pct = round(-7.14 * 1.3, 2)  # -9.28
    assert r['predicted_change_pct_3m'] == expected_pct, r['predicted_change_pct_3m']
    assert r['confidence_score_3m'] == 60


def test_opposite_signs_clamped():
    # 3m bullish, 6m bearish — both > 5% floor → opposite-sign branch fires,
    # 3m pulled onto glide path: round(-10.0 * 0.5, 2) = -5.0
    r = _sanitize_predictions(_base(
        predicted_price_3m=130.0, predicted_change_pct_3m=30.0,
        predicted_price_6m=90.0,  predicted_change_pct_6m=-10.0,
    ))
    assert r['predicted_change_pct_3m'] == round(-10.0 * 0.5, 2), r['predicted_change_pct_3m']
    assert r['confidence_score_3m'] == 25


def test_opposite_signs_small_no_clamp():
    # Both magnitudes under the 5% floor → noise, leave unchanged
    r = _sanitize_predictions(_base(
        predicted_price_3m=97.0, predicted_change_pct_3m=-3.0,
        predicted_price_6m=104.0, predicted_change_pct_6m=4.0,
    ))
    assert r['predicted_change_pct_3m'] == -3.0
    assert r['confidence_score_3m'] == 70


def test_reported_dip_pattern_clamped():
    # +3.3%/+2.1% short, -7.81% 3m, +17.41% 6m
    r = _sanitize_predictions(_base(
        predicted_price_3m=92.19, predicted_change_pct_3m=-7.81,
        predicted_price_6m=117.41, predicted_change_pct_6m=17.41,
    ))
    expected = round(17.41 * 0.5, 2)
    assert r['predicted_change_pct_3m'] == expected, r['predicted_change_pct_3m']
    assert r['confidence_score_3m'] == 25


def test_below_floor_no_clamp_even_if_ratio_high():
    # pct_3m=5%, pct_6m=1% → ratio=5 but pct_3m below 15% floor → no clamp
    r = _sanitize_predictions(_base(
        predicted_price_3m=105.0, predicted_change_pct_3m=5.0,
        predicted_price_6m=101.0, predicted_change_pct_6m=1.0,
    ))
    assert r['predicted_change_pct_3m'] == 5.0
    assert r['confidence_score_3m'] == 70


def test_below_ratio_no_clamp_even_if_above_floor():
    # pct_3m=20%, pct_6m=18% → ratio=1.11 below 1.5 → no clamp
    r = _sanitize_predictions(_base(
        predicted_price_3m=120.0, predicted_change_pct_3m=20.0,
        predicted_price_6m=118.0, predicted_change_pct_6m=18.0,
    ))
    assert r['predicted_change_pct_3m'] == 20.0
    assert r['confidence_score_3m'] == 70


def test_bound_clamp_also_updates_price():
    # 6m at +200% → exceeds vol-scaled bound (~63.64%) → both pct AND price should clamp
    r = _sanitize_predictions(_base(
        predicted_price_6m=300.0, predicted_change_pct_6m=200.0,
    ))
    assert abs(r['predicted_change_pct_6m'] - _6M_BOUND) < 0.01, r['predicted_change_pct_6m']
    # price should be recomputed from clamped pct
    expected_price = round(100.0 * (1 + _6M_BOUND / 100), 2)
    assert r['predicted_price_6m'] == expected_price, r['predicted_price_6m']
    assert r['confidence_score_6m'] == 25


def test_1w_clamp_consistent_with_1m_preserves_confidence():
    # 1w exceeds vol-scaled bound (~12.68%) but direction and magnitude are
    # consistent with 1m trajectory → confidence should NOT be knocked to 25.
    r = _sanitize_predictions(_base(
        predicted_price_1w=118.0, predicted_change_pct_1w=18.0, confidence_score_1w=94,
        predicted_price_1m=123.0, predicted_change_pct_1m=23.0,
    ))
    # Clamped to ~12.68%; still positive; same direction as 1m (+23%) and smaller magnitude
    assert abs(r['predicted_change_pct_1w'] - _1W_BOUND) < 0.01, r['predicted_change_pct_1w']
    expected_price = round(100.0 * (1 + _1W_BOUND / 100), 2)
    assert r['predicted_price_1w'] == expected_price, r['predicted_price_1w']
    assert r['confidence_score_1w'] == 94                # preserved — consistent ceiling hit


def test_1w_clamp_inconsistent_with_1m_knocks_confidence():
    # 1w exceeds bound → clamped to ~12.68%; but |clamped_1w| > |pct_1m|=4% → low trust
    r = _sanitize_predictions(_base(
        predicted_price_1w=120.0, predicted_change_pct_1w=20.0, confidence_score_1w=90,
        predicted_price_1m=104.0, predicted_change_pct_1m=4.0,
    ))
    assert abs(r['predicted_change_pct_1w'] - _1W_BOUND) < 0.01, r['predicted_change_pct_1w']
    assert r['confidence_score_1w'] == 25                # 1w > 1m magnitude → low trust


def test_1w_clamp_wrong_direction_knocks_confidence():
    # 1w clamped positive but 1m is negative → inconsistent direction
    r = _sanitize_predictions(_base(
        predicted_price_1w=120.0, predicted_change_pct_1w=20.0, confidence_score_1w=88,
        predicted_price_1m=95.0,  predicted_change_pct_1m=-5.0,
    ))
    assert abs(r['predicted_change_pct_1w'] - _1W_BOUND) < 0.01, r['predicted_change_pct_1w']
    assert r['confidence_score_1w'] == 25                # opposite direction → low trust


def test_bound_clamp_recenters_range():
    # 1w at +20% with a stored range → range should be re-centered on the
    # clamped price, not left anchored to the original ($120).
    r = _sanitize_predictions(_base(
        predicted_price_1w=120.0, predicted_change_pct_1w=20.0,
        predicted_range_1w=[117.0, 123.0],               # spread=6, center=120
        predicted_price_1m=123.0, predicted_change_pct_1m=23.0,
    ))
    new_price = round(100.0 * (1 + _1W_BOUND / 100), 2)
    assert abs(r['predicted_change_pct_1w'] - _1W_BOUND) < 0.01, r['predicted_change_pct_1w']
    assert r['predicted_price_1w'] == new_price
    # Range must be re-centered on new price (not 120)
    midpoint = round((r['predicted_range_1w'][0] + r['predicted_range_1w'][1]) / 2, 2)
    assert abs(midpoint - new_price) < 0.02, r['predicted_range_1w']


def test_bound_clamp_chains_into_consistency_check():
    # 3m at +100% → bound-clamps to 45.0%; 6m at +20% → ratio=45/20=2.25>1.5
    # and 45>15 → cross-horizon check fires too, re-clamps 3m to 20*1.3=26.0%
    # and sets confidence_3m=60 (moderate, overwriting the bound-clamp's 25).
    r = _sanitize_predictions(_base(
        predicted_price_3m=200.0, predicted_change_pct_3m=100.0,
        predicted_price_6m=120.0, predicted_change_pct_6m=20.0,
    ))
    assert r['predicted_change_pct_3m'] == 26.0, r['predicted_change_pct_3m']
    assert r['predicted_price_3m'] == 126.0, r['predicted_price_3m']
    assert r['confidence_score_3m'] == 60         # cross-horizon spike check sets moderate


def test_negative_price_floored():
    r = _sanitize_predictions(_base(
        predicted_price_6m=-5.0, predicted_change_pct_6m=-105.0,
    ))
    # Price floor fires first (negative price → 0.01), then pct is re-read and
    # clamped to -_6M_BOUND. Final pct should be near the negative bound.
    assert r['predicted_change_pct_6m'] >= -_6M_BOUND - 0.01, r['predicted_change_pct_6m']
    assert r['confidence_score_6m'] == 25


def test_missing_horizon_skipped():
    # If 3m is missing, sanitize must not crash and 6m still works
    case = _base(predicted_price_3m=None, predicted_change_pct_3m=None)
    r = _sanitize_predictions(case)
    # Cross-horizon check needs both 3m and 6m → silently skips
    assert r['predicted_change_pct_6m'] == 10.0


def main():
    tests = [
        test_legitimate_prediction_unchanged,
        test_overshoot_3m_vs_6m_clamps_and_lowers_confidence,
        test_negative_overshoot_also_clamps,
        test_opposite_signs_clamped,
        test_opposite_signs_small_no_clamp,
        test_reported_dip_pattern_clamped,
        test_below_floor_no_clamp_even_if_ratio_high,
        test_below_ratio_no_clamp_even_if_above_floor,
        test_bound_clamp_also_updates_price,
        test_1w_clamp_consistent_with_1m_preserves_confidence,
        test_1w_clamp_inconsistent_with_1m_knocks_confidence,
        test_1w_clamp_wrong_direction_knocks_confidence,
        test_bound_clamp_recenters_range,
        test_bound_clamp_chains_into_consistency_check,
        test_negative_price_floored,
        test_missing_horizon_skipped,
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
