#!/usr/bin/env python3
"""
test_sanitize_predictions.py — standalone tests for _sanitize_predictions().

Run directly:
    python3 scripts/test_sanitize_predictions.py

Mirrors the flat-file pattern of scripts/test_feature_columns.py (no pytest
dependency; each function asserts and the bottom of the file invokes them).
"""
import os
import sys

# Allow running from anywhere
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from predict_core import _sanitize_predictions


def _base(**overrides):
    """A minimal valid prediction result. Tests merge their fields in."""
    base = {
        'ticker': 'TEST',
        'regularMarketPrice': 100.0,
        'predicted_price_1w':  101.0, 'predicted_change_pct_1w':  1.0, 'confidence_score_1w': 70,
        'predicted_price_1m':  103.0, 'predicted_change_pct_1m':  3.0, 'confidence_score_1m': 70,
        'predicted_price_6m':  110.0, 'predicted_change_pct_6m': 10.0, 'confidence_score_6m': 70,
        'predicted_price_1y':  120.0, 'predicted_change_pct_1y': 20.0, 'confidence_score_1y': 65,
    }
    base.update(overrides)
    return base


def test_legitimate_prediction_unchanged():
    r = _sanitize_predictions(_base())
    assert r['predicted_change_pct_6m'] == 10.0
    assert r['predicted_price_6m'] == 110.0
    assert r['confidence_score_6m'] == 70


def test_overshoot_6m_vs_1y_clamps_and_lowers_confidence():
    # KO-style: pct_6m=23.8, pct_1y=8.2 → ratio 2.92, floor 15% → fires
    r = _sanitize_predictions(_base(
        regularMarketPrice=67.30,
        predicted_price_6m=83.32, predicted_change_pct_6m=23.8,
        predicted_price_1y=72.82, predicted_change_pct_1y=8.2,
    ))
    # pct_6m should be clamped to 1.3 × pct_1y = 10.66
    assert r['predicted_change_pct_6m'] == 10.66, r['predicted_change_pct_6m']
    # price should follow: 67.30 * 1.1066 = 74.47
    assert r['predicted_price_6m'] == 74.47, r['predicted_price_6m']
    # confidence dropped
    assert r['confidence_score_6m'] == 25


def test_negative_overshoot_also_clamps():
    # PFE-style: pct_6m=-16.22, pct_1y=-7.14 → ratio 2.27, fires on bearish side
    r = _sanitize_predictions(_base(
        regularMarketPrice=24.02,
        predicted_price_6m=20.12, predicted_change_pct_6m=-16.22,
        predicted_price_1y=22.31, predicted_change_pct_1y=-7.14,
    ))
    expected_pct = round(-7.14 * 1.3, 2)  # -9.28
    assert r['predicted_change_pct_6m'] == expected_pct, r['predicted_change_pct_6m']
    assert r['confidence_score_6m'] == 25


def test_opposite_signs_clamped():
    # 6m bullish, 1y bearish — both > 5% floor → opposite-sign branch fires,
    # 6m pulled onto glide path: round(-10.0 * 0.5, 2) = -5.0
    r = _sanitize_predictions(_base(
        predicted_price_6m=130.0, predicted_change_pct_6m=30.0,
        predicted_price_1y=90.0,  predicted_change_pct_1y=-10.0,
    ))
    assert r['predicted_change_pct_6m'] == round(-10.0 * 0.5, 2), r['predicted_change_pct_6m']
    assert r['confidence_score_6m'] == 25


def test_opposite_signs_small_no_clamp():
    # Both magnitudes under the 5% floor → noise, leave unchanged
    r = _sanitize_predictions(_base(
        predicted_price_6m=97.0, predicted_change_pct_6m=-3.0,
        predicted_price_1y=104.0, predicted_change_pct_1y=4.0,
    ))
    assert r['predicted_change_pct_6m'] == -3.0
    assert r['confidence_score_6m'] == 70


def test_reported_dip_pattern_clamped():
    # Exact user-reported case: +3.3%/+2.1% short, -7.81% 6m, +17.41% 1y
    # Regression test for the bug that prompted this fix.
    r = _sanitize_predictions(_base(
        predicted_price_6m=92.19, predicted_change_pct_6m=-7.81,
        predicted_price_1y=117.41, predicted_change_pct_1y=17.41,
    ))
    expected = round(17.41 * 0.5, 2)
    assert r['predicted_change_pct_6m'] == expected, r['predicted_change_pct_6m']
    assert r['confidence_score_6m'] == 25


def test_below_floor_no_clamp_even_if_ratio_high():
    # pct_6m=5%, pct_1y=1% → ratio=5 but pct_6m below 15% floor → no clamp
    r = _sanitize_predictions(_base(
        predicted_price_6m=105.0, predicted_change_pct_6m=5.0,
        predicted_price_1y=101.0, predicted_change_pct_1y=1.0,
    ))
    assert r['predicted_change_pct_6m'] == 5.0
    assert r['confidence_score_6m'] == 70


def test_below_ratio_no_clamp_even_if_above_floor():
    # pct_6m=20%, pct_1y=18% → ratio=1.11 below 1.5 → no clamp
    r = _sanitize_predictions(_base(
        predicted_price_6m=120.0, predicted_change_pct_6m=20.0,
        predicted_price_1y=118.0, predicted_change_pct_1y=18.0,
    ))
    assert r['predicted_change_pct_6m'] == 20.0
    assert r['confidence_score_6m'] == 70


def test_bound_clamp_also_updates_price():
    # 1y at +200% → exceeds ±100% bound → both pct AND price should clamp
    r = _sanitize_predictions(_base(
        predicted_price_1y=300.0, predicted_change_pct_1y=200.0,
    ))
    assert r['predicted_change_pct_1y'] == 100.0
    # price should be recomputed from clamped pct: 100 * 2.0 = 200.0
    assert r['predicted_price_1y'] == 200.0, r['predicted_price_1y']
    assert r['confidence_score_1y'] == 25


def test_1w_clamp_consistent_with_1m_preserves_confidence():
    # UCTT-style: 1w exceeds ±15% bound but direction and magnitude are
    # consistent with 1m trajectory → confidence should NOT be knocked to 25.
    r = _sanitize_predictions(_base(
        predicted_price_1w=118.0, predicted_change_pct_1w=18.0, confidence_score_1w=94,
        predicted_price_1m=123.0, predicted_change_pct_1m=23.0,
    ))
    assert r['predicted_change_pct_1w'] == 15.0          # still clamped
    assert r['predicted_price_1w'] == 115.0              # 100 * 1.15
    assert r['confidence_score_1w'] == 94                # preserved — consistent ceiling hit


def test_1w_clamp_inconsistent_with_1m_knocks_confidence():
    # 1w exceeds bound AND ends up larger than 1m magnitude → rogue prediction
    r = _sanitize_predictions(_base(
        predicted_price_1w=120.0, predicted_change_pct_1w=20.0, confidence_score_1w=90,
        predicted_price_1m=104.0, predicted_change_pct_1m=4.0,
    ))
    assert r['predicted_change_pct_1w'] == 15.0
    assert r['confidence_score_1w'] == 25                # 1w > 1m magnitude → low trust


def test_1w_clamp_wrong_direction_knocks_confidence():
    # 1w clamps positive but 1m is negative → inconsistent direction
    r = _sanitize_predictions(_base(
        predicted_price_1w=120.0, predicted_change_pct_1w=20.0, confidence_score_1w=88,
        predicted_price_1m=95.0,  predicted_change_pct_1m=-5.0,
    ))
    assert r['predicted_change_pct_1w'] == 15.0
    assert r['confidence_score_1w'] == 25                # opposite direction → low trust


def test_bound_clamp_recenters_range():
    # 1w at +20% with a stored range → range should be re-centered on the
    # clamped price ($115), not left anchored to the original ($120).
    r = _sanitize_predictions(_base(
        predicted_price_1w=120.0, predicted_change_pct_1w=20.0,
        predicted_range_1w=[117.0, 123.0],               # spread = 6, center = 120
        predicted_price_1m=123.0, predicted_change_pct_1m=23.0,
    ))
    assert r['predicted_change_pct_1w'] == 15.0
    assert r['predicted_price_1w'] == 115.0
    # Range should be re-centered on 115 with spread 6: [112.0, 118.0]
    assert r['predicted_range_1w'] == [112.0, 118.0], r['predicted_range_1w']


def test_bound_clamp_chains_into_consistency_check():
    # 6m at +100% (over bound, clamps to 60); 1y at +30% → ratio 60/30=2.0 trips
    # the cross-horizon check too → 6m re-clamps to 30*1.3=39
    r = _sanitize_predictions(_base(
        predicted_price_6m=200.0, predicted_change_pct_6m=100.0,
        predicted_price_1y=130.0, predicted_change_pct_1y=30.0,
    ))
    assert r['predicted_change_pct_6m'] == 39.0
    assert r['predicted_price_6m'] == 139.0
    assert r['confidence_score_6m'] == 25


def test_negative_price_floored():
    r = _sanitize_predictions(_base(
        predicted_price_1y=-5.0, predicted_change_pct_1y=-105.0,
    ))
    # pct also exceeds the -100% bound → clamps to -100; price gets floored
    # via the floor branch AND recomputed via the pct branch. Final price
    # comes from the pct recompute: 100 * (1 - 1.0) = 0.0, but the round()
    # keeps that at 0.0. The floor branch ran first so the floor effect
    # was visible mid-loop; what matters here is the final state.
    assert r['predicted_change_pct_1y'] == -100.0
    assert r['confidence_score_1y'] == 25


def test_missing_horizon_skipped():
    # If 6m is missing, sanitize must not crash and 1y still works
    case = _base(predicted_price_6m=None, predicted_change_pct_6m=None)
    r = _sanitize_predictions(case)
    # Cross-horizon check needs both 6m and 1y → silently skips
    assert r['predicted_change_pct_1y'] == 20.0


def main():
    tests = [
        test_legitimate_prediction_unchanged,
        test_overshoot_6m_vs_1y_clamps_and_lowers_confidence,
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
