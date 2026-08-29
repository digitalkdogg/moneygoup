#!/usr/bin/env python3
"""
test_feature_columns.py

Validates every column in FEATURE_COLUMNS is:
  1. Present in the feature DataFrame output
  2. Not entirely NaN after the general fill
  3. Not entirely zero for columns that should have real signal
  4. Within a plausible numeric range

Runs completely offline — no network calls, no API keys required.
It imports _calculate_features_internal and FEATURE_COLUMNS directly
from predict_weighted_analysis.py.

Usage:
    python3 scripts/test_feature_columns.py
    python3 scripts/test_feature_columns.py --verbose
"""

import sys
import os
import argparse
import numpy as np
import pandas as pd
from datetime import date, datetime, timedelta

# ── Path setup ───────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))

try:
    from predict_weighted_analysis import (
        FEATURE_COLUMNS,
        _calculate_features_internal,
    )
except ImportError as e:
    print(f"[FATAL] Cannot import from predict_weighted_analysis: {e}")
    print("        Run this script from the project root:")
    print("        python3 scripts/test_feature_columns.py")
    sys.exit(1)

# ── ANSI colours ─────────────────────────────────────────────────────────────
PASS  = '\033[92m✓ PASS\033[0m'
FAIL  = '\033[91m✗ FAIL\033[0m'
WARN  = '\033[93m⚠ WARN\033[0m'
INFO  = '\033[94m→\033[0m'
BOLD  = '\033[1m'
RESET = '\033[0m'

# ── Synthetic data generation ─────────────────────────────────────────────────

def _make_dates(n_days=1260):
    """Generate n_days of business-day dates ending yesterday."""
    end   = date.today() - timedelta(days=1)
    dates = pd.bdate_range(end=end, periods=n_days)
    return [d.strftime('%Y-%m-%d') for d in dates]


def _make_ohlcv(date_strs):
    """Geometric random walk with realistic volume."""
    n  = len(date_strs)
    rng = np.random.default_rng(42)
    log_returns = rng.normal(0.0004, 0.015, n)
    close = 100.0 * np.exp(np.cumsum(log_returns))

    noise = rng.uniform(0.98, 1.02, n)
    open_ = close * noise
    high  = np.maximum(close, open_) * rng.uniform(1.00, 1.02, n)
    low   = np.minimum(close, open_) * rng.uniform(0.98, 1.00, n)
    vol   = rng.integers(500_000, 5_000_000, n).astype(float)

    df = pd.DataFrame({
        'Date':   date_strs,
        'Open':   open_,
        'High':   high,
        'Low':    low,
        'Close':  close,
        'Volume': vol,
    })
    return df


def _make_macro_series(date_strs, base=100.0, drift=0.0001, noise=0.008):
    """Return [{date, close}] with realistic time-series behaviour."""
    rng = np.random.default_rng(0)
    n   = len(date_strs)
    vals = base * np.exp(np.cumsum(rng.normal(drift, noise, n)))
    return [{'date': d, 'close': float(v)} for d, v in zip(date_strs, vals)]


def build_mock_inputs(date_strs):
    """
    Assemble every input that _calculate_features_internal expects,
    with values that ensure all columns get real (non-trivial) signal.
    """
    df = _make_ohlcv(date_strs)
    current_price = float(df['Close'].iloc[-1])

    # ── stock_metrics ────────────────────────────────────────────────────────
    next_e = (date.today() + timedelta(days=45)).isoformat()
    last_e = (date.today() - timedelta(days=30)).isoformat()

    stock_metrics = {
        'regularMarketPrice':  current_price,
        'peRatio':             22.5,
        'pbRatio':             3.1,
        'trailingEps':         4.2,
        'forwardEps':          4.8,
        'revenueGrowth':       0.07,
        'earningsGrowth':      0.09,
        'profitMargins':       0.12,
        'debtToEquity':        55.0,
        'returnOnEquity':      0.18,
        'beta':                1.1,
        'dividendYield':       0.015,
        'analystTargetMean':   current_price * 1.12,
        'analystTargetMedian': current_price * 1.10,
        'analystTargetHigh':   current_price * 1.30,
        'analystTargetLow':    current_price * 0.95,
        'analystOpinionCount': 28,
        'recommendationMean':  2.1,
        'fiftyTwoWeekChange':  0.18,
        'sector':              'Technology',
        'nextEarningsDate':    next_e,
        'lastEarningsDate':    last_e,
    }

    # ── macro_data ───────────────────────────────────────────────────────────
    vix_vals   = _make_macro_series(date_strs, base=18.0,  drift=0.0,    noise=0.04)
    tnx_vals   = _make_macro_series(date_strs, base=4.2,   drift=0.0001, noise=0.01)
    etf_vals   = _make_macro_series(date_strs, base=150.0, drift=0.0004, noise=0.012)
    hyg_vals   = _make_macro_series(date_strs, base=78.0,  drift=0.0001, noise=0.005)
    lqd_vals   = _make_macro_series(date_strs, base=110.0, drift=0.0001, noise=0.004)
    dxy_vals   = _make_macro_series(date_strs, base=103.0, drift=0.0,    noise=0.003)
    spy_vals   = _make_macro_series(date_strs, base=450.0, drift=0.0004, noise=0.011)
    irx_vals   = _make_macro_series(date_strs, base=5.2,   drift=0.0,    noise=0.008)
    wti_vals   = _make_macro_series(date_strs, base=80.0,  drift=0.0,    noise=0.02)
    copper_vals= _make_macro_series(date_strs, base=4.2,   drift=0.0,    noise=0.015)
    wheat_vals = _make_macro_series(date_strs, base=6.0,   drift=0.0,    noise=0.02)

    macro_data = {
        'vix':        vix_vals,
        'treasury10y':tnx_vals,
        'sectorEtf':  {'ticker': 'XLK', 'data': etf_vals},
        'hyg':        hyg_vals,
        'lqd':        lqd_vals,
        'dxy':        dxy_vals,
        'spy':        spy_vals,
        'treasury3m': irx_vals,
        'wti':        wti_vals,
        'copper':     copper_vals,
        'wheat':      wheat_vals,
        'worldBank':  {
            'indicators': {
                'gdpGrowth':         2.8,
                'inflation':         3.1,
                'consumptionGrowth': 2.5,
            }
        },
    }

    # ── feature_metrics (all new fields from the 9-item implementation) ───────
    # Build 8 earnings dates — 4 past, 4 future quarters
    earn_history = []
    for q in range(4):
        d = (date.today() - timedelta(days=90 * (q + 1))).isoformat() + 'T00:00:00'
        earn_history.append({'date': d, 'surprise': round(np.random.uniform(-5, 15), 2)})

    feature_metrics = {
        # Earnings surprises
        'epsSurpriseAvg4Q':    5.2,
        'revenueSurpriseAvg4Q': 2.1,
        # Short interest
        'shortFloatPct':       0.032,
        'daysToCover':         2.4,
        # Insider activity
        'insiderNetSellRatio90d': 0.0015,
        'insiderTxCount90d':      7,
        # Item 01 & 02: earnings dates
        'lastEarningsDate':    last_e + 'T00:00:00',
        'earningsDateHistory': earn_history,
        # Item 03: EPS revision velocity
        'epsRevision7d_0Q':    0.032,
        'epsRevision7d_1Q':    0.018,
        'epsRevisionsUp7d':    4,
        'epsRevisionsDown7d':  1,
        'revenueEstGrowth_0Q': 0.06,
        'revenueEstGrowth_1Q': 0.08,
        # Item 04: upgrade/downgrade recency
        'upgradeScore7d':      0.5,
        'upgradeScore30d':     0.25,
        # Item 05: pre/post market
        'preMarketChangePct':  0.004,
        'postMarketChangePct': -0.001,
        'fiftyTwoWeekPosRatio': 0.72,
        'avgDailyVol3M':       3_200_000,
        # Item 06: institution ownership
        'instPctHeld':         0.68,
        'instPctDelta':        0.012,
        'insiderPctHeld':      0.05,
        'institutionCount':    1_450,
        # Item 08: peer relative strength
        'peerRS5d':            0.008,
    }

    # ── options data ─────────────────────────────────────────────────────────
    options_data = {
        'iv':           0.28,
        'ivRank':       45.0,
        'putCallRatio': 0.72,
        'available':    True,
    }

    return df, stock_metrics, macro_data, feature_metrics, options_data, current_price


# ── Column-level validation rules ─────────────────────────────────────────────

# Columns that are legitimately 0 or very near 0 in a long history
# (e.g. GoldenCross is binary, EarningsSeason is sparse, etc.)
ALLOW_ALL_ZERO = {
    'GoldenCross',        # binary, could be all 0 or all 1
    'EarningsSeason',     # sparse (only Jan/Apr/Jul/Oct)
    'InsiderNetSellRatio_90d', # only recent rows populated
    'InsiderTxCount_90d',
    'PostEarnings_CumReturn',  # could be near-zero
    'EPS_Revision_7d_0Q',
    'EPS_Revision_7d_1Q',
    'Revenue_Est_Growth_0Q',
    'Revenue_Est_Growth_1Q',
    'EPS_Rev_Up7d',
    'EPS_Rev_Down7d',
    'Upgrade_Score_7d',
    'Upgrade_Score_30d',
    'PostMarket_GapPct',
    'Institution_PctDelta',
    'Peer_RS_5d',
}

# Expected value ranges: (min, max) inclusive.  None = skip range check.
EXPECTED_RANGES = {
    # OHLCV — price-derived, should be positive
    'Open':   (0, None), 'High': (0, None), 'Low': (0, None),
    'Close':  (0, None), 'Volume': (0, None),
    # RSI
    'RSI_14': (0, 100),
    # Stochastic
    'STOCH_K': (0, 100), 'STOCH_D': (0, 100),
    # Ratios
    'HiRatio_52w': (0, 1.05), 'LoRatio_52w': (1.0, None),
    # Calendar cyclicals
    'Month_Sin': (-1, 1), 'Month_Cos': (-1, 1),
    'EarningsSeason': (0, 1),
    'GoldenCross':    (0, 1),
    'Earnings_In_Window': (0, 1),
    # Fundamentals
    'PE_Ratio':        (0, None),
    'PB_Ratio':        (0, None),
    # Upgrade scores
    'Upgrade_Score_7d':  (-1, 1),
    'Upgrade_Score_30d': (-1, 1),
    # 52w position
    'FiftyTwoWeek_PosRatio': (-0.1, 1.1),
    # Vol ratio — clipped to [0.1, 10]
    'PostEarnings_VolRatio': (0.09, 10.1),
    'PostEarnings_DayN':     (0, 22),
    # Days to earnings
    'Days_To_Next_Earnings':    (-500, 1400),  # synthetic data spans 1260 days; first row can be ~1305
    'Days_Since_Last_Earnings': (0, None),
    # WorldBank
    'WorldBank_GDP':       (-10, 15),
    'WorldBank_Inflation': (-5, 30),
    # Institution
    'Institution_PctHeld': (0, 1.05),
}


# ── Test runner ───────────────────────────────────────────────────────────────

def run_tests(verbose=False):
    print(f'\n{"═" * 68}')
    print(f'  {BOLD}Feature Column Validator — predict_weighted_analysis.py{RESET}')
    print(f'{"═" * 68}')

    # ── Build synthetic data ──────────────────────────────────────────────────
    date_strs = _make_dates(1_260)   # ~5 trading years
    print(f'\n{INFO} Generating synthetic data  ({len(date_strs)} trading days)…', end='', flush=True)

    df, stock_metrics, macro_data, feature_metrics, options_data, current_price = \
        build_mock_inputs(date_strs)

    print(f'  done\n{INFO} Running _calculate_features_internal…', end='', flush=True)

    try:
        feat_df = _calculate_features_internal(
            df=df,
            stock_metrics=stock_metrics,
            macro_data=macro_data,
            news_sentiment=0.15,
            earnings_beat_streak=2,
            current_price=current_price,
            options_data=options_data,
            feature_metrics=feature_metrics,
        )
    except Exception as exc:
        print(f'\n  {FAIL}  _calculate_features_internal raised: {exc}')
        import traceback
        traceback.print_exc()
        sys.exit(1)

    print('  done\n')

    # ── Check output shape ───────────────────────────────────────────────────
    expected_n_cols = len(FEATURE_COLUMNS)
    actual_n_cols   = len(feat_df.columns)

    if actual_n_cols >= expected_n_cols:
        print(f'  {PASS}  Column count: {actual_n_cols} columns in output  '
              f'({expected_n_cols} in FEATURE_COLUMNS)')
    else:
        print(f'  {FAIL}  Column count: got {actual_n_cols}, expected ≥ {expected_n_cols}')

    print(f'\n  {"─"*64}')
    print(f'  {"Column":<36}  {"NaN%":>6}  {"AllZero":>7}  {"Range":>7}  Result')
    print(f'  {"─"*64}')

    results = []

    for col in FEATURE_COLUMNS:
        issues = []

        # 1. Existence
        if col not in feat_df.columns:
            issues.append('MISSING')
            results.append((col, False, 'MISSING', None, None))
            row = f'  {col:<36}  {"—":>6}  {"—":>7}  {"—":>7}  {FAIL} MISSING'
            print(row)
            continue

        series = feat_df[col]
        nan_pct = series.isna().mean() * 100

        # 2. NaN check
        if nan_pct > 5.0:
            issues.append(f'{nan_pct:.0f}% NaN')

        # 3. All-zero check (skip for allowed-zero columns)
        all_zero = (series.fillna(0).abs() < 1e-12).all()
        if all_zero and col not in ALLOW_ALL_ZERO:
            issues.append('ALL_ZERO')

        # 4. Range check
        range_ok = True
        lo, hi = EXPECTED_RANGES.get(col, (None, None))
        if lo is not None or hi is not None:
            vals = series.dropna()
            if len(vals) > 0:
                vmin, vmax = vals.min(), vals.max()
                if lo is not None and vmin < lo - 1e-6:
                    issues.append(f'min={vmin:.3g}<{lo}')
                    range_ok = False
                if hi is not None and vmax > hi + 1e-6:
                    issues.append(f'max={vmax:.3g}>{hi}')
                    range_ok = False

        passed = len(issues) == 0
        result_str = PASS if passed else FAIL

        zero_str  = 'yes' if all_zero else 'no'
        range_str = 'ok'  if range_ok else 'OOB'

        if verbose or not passed:
            issue_txt = f'  [{", ".join(issues)}]' if issues else ''
            print(f'  {col:<36}  {nan_pct:>5.1f}%  {zero_str:>7}  {range_str:>7}  {result_str}{issue_txt}')

        results.append((col, passed, issues, nan_pct, range_ok))

    # ── Spot-checks for new earnings features ────────────────────────────────
    print(f'\n  {"─"*64}')
    print(f'  {BOLD}Spot-checks — earnings & post-earnings logic{RESET}')
    print(f'  {"─"*64}')

    spot_results = []

    def spot(label, condition, detail=''):
        ok = bool(condition)
        spot_results.append(ok)
        tag = PASS if ok else FAIL
        suffix = f'  ({detail})' if detail else ''
        print(f'  {tag}  {label}{suffix}')

    # Earnings_In_Window should be 1.0 for rows close to last_e (30 days ago)
    last_e_date = date.today() - timedelta(days=30)
    recent_mask = pd.to_datetime(feat_df.index).date >= last_e_date - timedelta(days=7) if hasattr(feat_df.index, '__iter__') else None

    eiw_vals = feat_df['Earnings_In_Window'].values
    spot('Earnings_In_Window has some 1.0 values',
         (eiw_vals == 1.0).any(),
         f'{(eiw_vals==1.0).sum()} rows flagged')

    spot('Days_To_Next_Earnings: last row is ~45',
         abs(feat_df['Days_To_Next_Earnings'].iloc[-1] - 45) < 3,
         f'got {feat_df["Days_To_Next_Earnings"].iloc[-1]:.1f}')

    spot('Days_Since_Last_Earnings: last row is ~30',
         abs(feat_df['Days_Since_Last_Earnings'].iloc[-1] - 30) < 3,
         f'got {feat_df["Days_Since_Last_Earnings"].iloc[-1]:.1f}')

    spot('PostEarnings_DayN has values 1–21',
         feat_df['PostEarnings_DayN'].between(0, 21).all(),
         f'max={feat_df["PostEarnings_DayN"].max():.0f}')

    spot('PostEarnings_VolRatio clipped to [0.1, 10]',
         feat_df['PostEarnings_VolRatio'].between(0.09, 10.1).all())

    spot('EPS_Revision_7d_0Q broadcast correctly',
         (feat_df['EPS_Revision_7d_0Q'] == 0.032).all(),
         f'value={feat_df["EPS_Revision_7d_0Q"].iloc[-1]:.4f}')

    spot('Upgrade_Score_7d broadcast correctly',
         (feat_df['Upgrade_Score_7d'] == 0.5).all(),
         f'value={feat_df["Upgrade_Score_7d"].iloc[-1]:.3f}')

    spot('PreMarket_GapPct broadcast correctly',
         (feat_df['PreMarket_GapPct'] == 0.004).all(),
         f'value={feat_df["PreMarket_GapPct"].iloc[-1]:.4f}')

    spot('Institution_PctHeld broadcast correctly',
         (feat_df['Institution_PctHeld'] == 0.68).all(),
         f'value={feat_df["Institution_PctHeld"].iloc[-1]:.3f}')

    spot('FiftyTwoWeek_PosRatio broadcast correctly',
         (feat_df['FiftyTwoWeek_PosRatio'] == 0.72).all(),
         f'value={feat_df["FiftyTwoWeek_PosRatio"].iloc[-1]:.3f}')

    spot('Peer_RS_5d broadcast correctly',
         (feat_df['Peer_RS_5d'] == 0.008).all(),
         f'value={feat_df["Peer_RS_5d"].iloc[-1]:.4f}')

    spot('No NaN in final DataFrame (all filled)',
         not feat_df.isnull().any().any(),
         f'{feat_df.isnull().sum().sum()} NaN cells remaining')

    # ── Summary ──────────────────────────────────────────────────────────────
    col_passed  = sum(1 for _, ok, *_ in results if ok)
    col_total   = len(results)
    spot_passed = sum(spot_results)
    spot_total  = len(spot_results)
    total_pass  = col_passed + spot_passed
    total_tests = col_total  + spot_total

    print(f'\n{"═" * 68}')
    print(f'  {BOLD}Summary{RESET}')
    print(f'{"═" * 68}')
    print(f'  FEATURE_COLUMNS checks : {col_passed}/{col_total}')
    print(f'  Spot-checks            : {spot_passed}/{spot_total}')
    print(f'  Total                  : {total_pass}/{total_tests}')

    if total_pass == total_tests:
        print(f'\n  {PASS}  All {total_tests} checks passed.\n')
        sys.exit(0)
    else:
        failed_cols = [col for col, ok, *_ in results if not ok]
        if failed_cols:
            print(f'\n  {FAIL}  Failed columns: {", ".join(failed_cols)}')
        print(f'\n  {FAIL}  {total_tests - total_pass} check(s) failed — see output above.\n')
        sys.exit(1)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Validate all FEATURE_COLUMNS in predict_weighted_analysis.py')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Print a row for every column, not just failures')
    args = parser.parse_args()
    run_tests(verbose=args.verbose)
