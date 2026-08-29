#!/usr/bin/env python3
"""
run_backtest.py — Single-command historical backtest for 1–100 stocks.

Usage:
    python3 scripts/backtest/run_backtest.py AAPL MSFT --period "1 year" --step 7
    python3 scripts/backtest/run_backtest.py AAPL --start 2025-01-01
    python3 scripts/backtest/run_backtest.py AAPL MSFT NVDA --period "6 months" --step 14 --output reports/q2.html
    python3 scripts/backtest/run_backtest.py --random 20 --period "6 months" --step 7
    python3 scripts/backtest/run_backtest.py --random 10 --seed 42 --period "1 year" --step 14

Period options (case-insensitive):
    "1 year"    / "1y"        365 days back from today
    "9 months"  / "9m"        270 days
    "6 months"  / "6m"        180 days
    "3 months"  / "3m"         90 days
    "1 month"   / "1m"         30 days
    "3 weeks"   / "3w"         21 days
    "1 week"    / "1w"          7 days
    "100 days"  / "100d"       100 days
    "180 days"  / "180d"       180 days
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional

import yfinance as yf
from dotenv import load_dotenv

# ── Paths ───────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).resolve().parent      # scripts/backtest/
PROJECT_ROOT = SCRIPT_DIR.parent.parent             # project root
sys.path.insert(0, str(SCRIPT_DIR.parent))          # expose scripts/ for imports

load_dotenv(PROJECT_ROOT / '.env.production', override=False)
load_dotenv(PROJECT_ROOT / '.env.local',      override=True)

from predict_weighted_analysis import predict       # noqa: E402

# ── Period aliases ──────────────────────────────────────────────────────────────
PERIOD_MAP: Dict[str, int] = {
    '1y': 365,   '1year': 365,   '1 year': 365,   '1-year': 365,
    '9m': 270,   '9mo': 270,     '9months': 270,   '9 months': 270,
    '6m': 180,   '6months': 180, '6 months': 180,
    '3m':  90,   '3months':  90, '3 months':  90,
    '1m':  30,   '1month':   30, '1 month':   30,
    '3w':  21,   '3weeks':   21, '3 weeks':   21,
    '1w':   7,   '1week':     7, '1 week':    7,
    '100d': 100, '100days': 100, '100 days': 100,
    '180d': 180, '180days': 180, '180 days': 180,
}

# ── Horizon config ──────────────────────────────────────────────────────────────
HORIZONS          = ['1w', '1m', '3m', '6m']
HORIZON_DAYS      = {'1w': 7, '1m': 30, '3m': 90, '6m': 180}
HORIZON_LABEL     = {'1w': '1 Week', '1m': '1 Month', '3m': '3 Months', '6m': '6 Months'}
DIRECTION_DEADBAND = {'1w': 0.005, '1m': 0.02, '3m': 0.05, '6m': 0.05}

# ── Macro symbols ───────────────────────────────────────────────────────────────
MACRO_SYMBOLS = {
    'vix': '^VIX', 'treasury10y': '^TNX', 'treasury3m': '^IRX',
    'hyg': 'HYG',  'lqd': 'LQD',          'dxy': 'DX-Y.NYB',
    'spy': 'SPY',  'wti': 'CL=F',          'copper': 'HG=F', 'wheat': 'ZW=F',
}
SECTOR_ETF = {
    'Technology': 'XLK', 'Healthcare': 'XLV', 'Financials': 'XLF',
    'Financial Services': 'XLF', 'Consumer Cyclical': 'XLY',
    'Consumer Defensive': 'XLP', 'Industrials': 'XLI', 'Energy': 'XLE',
    'Utilities': 'XLU', 'Real Estate': 'XLRE', 'Basic Materials': 'XLB',
    'Materials': 'XLB', 'Communication Services': 'XLC',
}
SECTOR_MEDIANS = {
    'Technology':             {'peRatio': 28.0, 'pbRatio': 6.0, 'profitMargins': 0.20, 'revenueGrowth': 0.10, 'debtToEquity': 50,  'returnOnEquity': 0.25},
    'Healthcare':             {'peRatio': 22.0, 'pbRatio': 4.0, 'profitMargins': 0.12, 'revenueGrowth': 0.07, 'debtToEquity': 60,  'returnOnEquity': 0.15},
    'Financials':             {'peRatio': 12.0, 'pbRatio': 1.2, 'profitMargins': 0.20, 'revenueGrowth': 0.05, 'debtToEquity': 200, 'returnOnEquity': 0.12},
    'Financial Services':     {'peRatio': 12.0, 'pbRatio': 1.2, 'profitMargins': 0.20, 'revenueGrowth': 0.05, 'debtToEquity': 200, 'returnOnEquity': 0.12},
    'Consumer Cyclical':      {'peRatio': 20.0, 'pbRatio': 3.5, 'profitMargins': 0.07, 'revenueGrowth': 0.06, 'debtToEquity': 80,  'returnOnEquity': 0.18},
    'Consumer Defensive':     {'peRatio': 18.0, 'pbRatio': 3.0, 'profitMargins': 0.08, 'revenueGrowth': 0.04, 'debtToEquity': 70,  'returnOnEquity': 0.15},
    'Industrials':            {'peRatio': 18.0, 'pbRatio': 3.0, 'profitMargins': 0.09, 'revenueGrowth': 0.06, 'debtToEquity': 90,  'returnOnEquity': 0.16},
    'Energy':                 {'peRatio': 12.0, 'pbRatio': 1.8, 'profitMargins': 0.10, 'revenueGrowth': 0.04, 'debtToEquity': 50,  'returnOnEquity': 0.12},
    'Utilities':              {'peRatio': 16.0, 'pbRatio': 1.5, 'profitMargins': 0.12, 'revenueGrowth': 0.03, 'debtToEquity': 120, 'returnOnEquity': 0.10},
    'Real Estate':            {'peRatio': 30.0, 'pbRatio': 2.0, 'profitMargins': 0.25, 'revenueGrowth': 0.05, 'debtToEquity': 100, 'returnOnEquity': 0.08},
    'Communication Services': {'peRatio': 20.0, 'pbRatio': 3.5, 'profitMargins': 0.15, 'revenueGrowth': 0.07, 'debtToEquity': 70,  'returnOnEquity': 0.18},
    'Basic Materials':        {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
    'Materials':              {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
    '_default':               {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
}

# ── Diverse ticker pool ─────────────────────────────────────────────────────────
# Organized by sector → cap tier. Used by --random N to build a diverse batch.
# Cap tiers: large (>$10B), mid ($2B–$10B), small (<$2B)
TICKER_POOL: Dict[str, Dict[str, List[str]]] = {
    'Technology': {
        'large': ['AAPL', 'MSFT', 'NVDA', 'ORCL', 'CSCO', 'IBM', 'INTC', 'AMD', 'QCOM', 'TXN', 'AVGO', 'NOW', 'ADBE', 'CRM', 'ACN'],
        'mid':   ['SNPS', 'CDNS', 'ANSS', 'MANH', 'DDOG', 'ZS', 'CRWD', 'MDB', 'PSTG', 'GTLB'],
        'small': ['CALX', 'IRDM', 'NTCT', 'ALRM', 'LFUS'],
    },
    'Healthcare': {
        'large': ['JNJ', 'UNH', 'LLY', 'PFE', 'MRK', 'ABBV', 'ABT', 'TMO', 'DHR', 'BMY', 'AMGN', 'ISRG', 'GILD', 'CI', 'HCA'],
        'mid':   ['JAZZ', 'PODD', 'EXAS', 'INSP', 'OMCL', 'PDCO'],
        'small': ['ACAD', 'PRGO', 'HALO', 'PNTG', 'CCRN'],
    },
    'Financial Services': {
        'large': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'BLK', 'AXP', 'SCHW', 'C', 'CB', 'PGR', 'TRV', 'MET', 'V', 'MA'],
        'mid':   ['RF', 'HBAN', 'KEY', 'CFG', 'WTFC', 'FNB', 'BOKF', 'SNV'],
        'small': ['NBTB', 'FBIZ', 'BSVN', 'CBAN', 'MBIN'],
    },
    'Consumer Cyclical': {
        'large': ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'SBUX', 'LOW', 'TJX', 'MAR', 'YUM', 'GM', 'F', 'BKNG'],
        'mid':   ['DRI', 'TXRH', 'BOOT', 'SIG', 'GRMN', 'RVLV'],
        'small': ['KRUS', 'DENN', 'RICK', 'PLCE'],
    },
    'Consumer Defensive': {
        'large': ['WMT', 'PG', 'KO', 'PEP', 'COST', 'MO', 'PM', 'CL', 'GIS', 'K', 'STZ', 'MDLZ', 'HRL'],
        'mid':   ['SFM', 'INGR', 'BGS', 'LANC', 'POST'],
        'small': ['JJSF', 'CENTA', 'HAIN', 'FIZZ'],
    },
    'Industrials': {
        'large': ['HON', 'GE', 'CAT', 'DE', 'UPS', 'FDX', 'LMT', 'RTX', 'BA', 'MMM', 'EMR', 'ETN', 'ITW', 'PH', 'WM'],
        'mid':   ['GNRC', 'WMS', 'GATX', 'DRS', 'MYRG', 'EXPO', 'FELE'],
        'small': ['KALU', 'HAYN', 'HTLD', 'ARCB', 'LNN'],
    },
    'Energy': {
        'large': ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'VLO', 'PSX', 'OXY', 'HAL', 'DVN'],
        'mid':   ['OVV', 'SM', 'CIVI', 'MUR', 'RRC'],
        'small': ['TALO', 'VTLE', 'REX', 'GPOR'],
    },
    'Utilities': {
        'large': ['NEE', 'DUK', 'SO', 'D', 'EXC', 'AEP', 'XEL', 'WEC', 'ES', 'ETR', 'AWK'],
        'mid':   ['EVRG', 'NWE', 'AVA', 'ALE', 'PNM'],
        'small': ['UTL', 'OTTR', 'MGEE', 'ARTNA'],
    },
    'Real Estate': {
        'large': ['PLD', 'AMT', 'CCI', 'EQIX', 'SPG', 'PSA', 'O', 'DLR', 'VICI', 'AVB', 'EQR'],
        'mid':   ['FR', 'NNN', 'STAG', 'BNL', 'IIPR'],
        'small': ['PLYM', 'NXRT', 'GOOD', 'ILPT'],
    },
    'Basic Materials': {
        'large': ['LIN', 'APD', 'ECL', 'SHW', 'FCX', 'NEM', 'NUE', 'VMC', 'MLM', 'ALB', 'DOW', 'LYB'],
        'mid':   ['MEOH', 'TROX', 'HWKN', 'SLGN', 'ASIX'],
        'small': ['ZEUS', 'SXT', 'CENX', 'IOSP'],
    },
    'Communication Services': {
        'large': ['GOOGL', 'META', 'DIS', 'CMCSA', 'NFLX', 'T', 'VZ', 'CHTR', 'TTWO'],
        'mid':   ['FOXA', 'PARA', 'LYV', 'NXST', 'IPG'],
        'small': ['SONO', 'WMG', 'IACI'],
    },
}


def sample_diverse(n: int, seed: Optional[int] = None) -> List[str]:
    """
    Pick n tickers with maximum sector + cap-tier diversity.
    Targets ~40% large, ~35% mid, ~25% small.
    Round-robins across sectors within each cap tier so no single sector dominates.
    """
    if n < 1:
        raise ValueError('--random must be >= 1')
    if n > 100:
        raise ValueError('--random must be <= 100')

    rng = random.Random(seed)

    # Target counts per cap tier
    n_large = max(0, round(n * 0.40))
    n_mid   = max(0, round(n * 0.35))
    n_small = max(0, n - n_large - n_mid)
    # Fix any rounding drift
    while n_large + n_mid + n_small > n:
        n_small -= 1
    while n_large + n_mid + n_small < n:
        n_large += 1

    sectors   = list(TICKER_POOL.keys())
    result    = []
    used: set = set()

    for cap, count in [('large', n_large), ('mid', n_mid), ('small', n_small)]:
        # Build per-sector lists for this cap tier, shuffled for randomness
        by_sector: Dict[str, List[str]] = {}
        for s in sectors:
            pool = [t for t in TICKER_POOL[s].get(cap, []) if t not in used]
            if pool:
                rng.shuffle(pool)
                by_sector[s] = pool

        active = list(by_sector.keys())
        rng.shuffle(active)   # random sector order each run

        picks: List[str] = []
        while len(picks) < count and active:
            for s in list(active):
                if len(picks) >= count:
                    break
                if by_sector[s]:
                    t = by_sector[s].pop(0)
                    picks.append(t)
                    used.add(t)
                else:
                    active.remove(s)

        result.extend(picks)

    rng.shuffle(result)
    return result


# ── CLI ─────────────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser(
        description='Run a historical backtest for 1–100 stocks.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument('tickers', nargs='*', metavar='TICKER',
                   help='Ticker symbols to backtest (e.g. AAPL MSFT NVDA). '
                        'Omit when using --random.')
    period_group = p.add_mutually_exclusive_group(required=True)
    period_group.add_argument('--period', '-p', metavar='PERIOD',
                              help='Lookback period e.g. "1 year", "6 months", "100 days"')
    period_group.add_argument('--start', '-s', metavar='YYYY-MM-DD',
                              help='Explicit start date')
    p.add_argument('--random', '-r', type=int, metavar='N', dest='random_n',
                   help='Pick N diverse random tickers (mix of sectors + large/mid/small cap). '
                        'Cannot be combined with explicit tickers.')
    p.add_argument('--seed', type=int, metavar='INT',
                   help='Random seed for --random (makes the ticker selection reproducible)')
    p.add_argument('--step', '-i', type=int, default=1, metavar='DAYS',
                   help='Increment between prediction dates in days (default: 1)')
    p.add_argument('--output', '-o', metavar='PATH',
                   help='Output HTML report path (default: reports/backtest_<date>.html)')
    p.add_argument('--quiet', '-q', action='store_true',
                   help='Suppress per-prediction progress output')
    return p.parse_args()


def resolve_start_date(args) -> date:
    if args.start:
        return date.fromisoformat(args.start)
    key = args.period.lower().strip()
    days = PERIOD_MAP.get(key)
    if days is None:
        valid = ', '.join(f'"{k}"' for k in PERIOD_MAP if ' ' in k or len(k) <= 3)
        raise SystemExit(f'Unknown period "{args.period}". Valid options: {valid}')
    return date.today() - timedelta(days=days)


# ── Data fetching ───────────────────────────────────────────────────────────────
def _series(df, col='Close') -> List[dict]:
    """Convert a yfinance DataFrame column to [{date, close}] list."""
    rows = []
    for idx, row in df.iterrows():
        val = float(row[col]) if not (isinstance(row[col], float) and math.isnan(row[col])) else None
        if val is not None:
            rows.append({'date': idx.strftime('%Y-%m-%d'), 'close': val})
    return rows


def fetch_macro(start_date: date, quiet: bool) -> tuple[dict, dict]:
    """Fetch all macro time-series and sector ETFs. Called once per run."""
    fetch_start = str(start_date - timedelta(days=730))
    fetch_end   = str(date.today() + timedelta(days=1))

    if not quiet:
        print('  Fetching macro data (VIX, rates, SPY, commodities)...')

    macro = {}
    for key, sym in MACRO_SYMBOLS.items():
        try:
            df = yf.download(sym, start=fetch_start, end=fetch_end,
                             progress=False, auto_adjust=True, threads=False)
            # Handle MultiIndex columns from yfinance
            if hasattr(df.columns, 'nlevels') and df.columns.nlevels > 1:
                df.columns = df.columns.get_level_values(0)
            macro[key] = _series(df) if not df.empty else []
        except Exception as e:
            if not quiet:
                print(f'  [warn] macro {sym}: {e}')
            macro[key] = []

    if not quiet:
        print('  Fetching sector ETFs...')

    etfs = {}
    for etf in set(SECTOR_ETF.values()) | {'SPY'}:
        try:
            df = yf.download(etf, start=fetch_start, end=fetch_end,
                             progress=False, auto_adjust=True, threads=False)
            if hasattr(df.columns, 'nlevels') and df.columns.nlevels > 1:
                df.columns = df.columns.get_level_values(0)
            etfs[etf] = _series(df) if not df.empty else []
        except Exception:
            etfs[etf] = []

    return macro, etfs


def fetch_ticker(ticker: str, start_date: date, quiet: bool) -> Optional[dict]:
    """Fetch full OHLCV history + static fundamentals for one ticker."""
    fetch_start = str(start_date - timedelta(days=730))
    fetch_end   = str(date.today() + timedelta(days=1))

    tk = yf.Ticker(ticker)
    try:
        hist = tk.history(start=fetch_start, end=fetch_end, auto_adjust=True)
    except Exception as e:
        print(f'  [{ticker}] history fetch failed: {e}')
        return None

    if hist.empty or len(hist) < 60:
        print(f'  [{ticker}] insufficient history ({len(hist)} rows) — skipping')
        return None

    ohlcv = []
    for idx, row in hist.iterrows():
        ohlcv.append({
            'date':   idx.strftime('%Y-%m-%d'),
            'open':   float(row.get('Open', 0) or 0),
            'high':   float(row.get('High', 0) or 0),
            'low':    float(row.get('Low', 0)  or 0),
            'close':  float(row.get('Close', 0) or 0),
            'volume': float(row.get('Volume', 0) or 0),
        })

    info   = {}
    try:
        info = tk.info or {}
    except Exception:
        pass

    sector  = info.get('sector', '_default') or '_default'
    medians = SECTOR_MEDIANS.get(sector, SECTOR_MEDIANS['_default'])
    etf_sym = SECTOR_ETF.get(sector, 'SPY')

    stock_metrics_template = {
        'sector':                    sector,
        'regularMarketPrice':        None,      # filled per date
        'peRatio':                   medians['peRatio'],
        'pbRatio':                   medians['pbRatio'],
        'profitMargins':             medians['profitMargins'],
        'revenueGrowth':             medians['revenueGrowth'],
        'debtToEquity':              medians['debtToEquity'],
        'returnOnEquity':            medians['returnOnEquity'],
        'trailingEps':               None,
        'forwardEps':                None,
        'earningsGrowth':            medians['revenueGrowth'],
        'beta':                      float(info.get('beta') or 1.0),
        'dividendYield':             float(info.get('dividendYield') or 0.0),
        'analystTargetMean':         None,
        'analystOpinionCount':       0,
        'recommendationMean':        3.0,
        'recommendationKey':         'hold',
        'nextEarningsDate':          None,
        'lastEarningsDate':          None,
        'sectorMedianPe':            medians['peRatio'],
        'sectorMedianPb':            medians['pbRatio'],
        'sectorMedianRevenueGrowth': medians['revenueGrowth'],
        'sectorMedianProfitMargins': medians['profitMargins'],
    }

    return {
        'ohlcv':    ohlcv,
        'metrics':  stock_metrics_template,
        'sector':   sector,
        'etf':      etf_sym,
    }


# ── Payload builder ─────────────────────────────────────────────────────────────
def _trunc(series: list, as_of_str: str) -> list:
    return [r for r in series if r['date'] <= as_of_str]


def build_payload(ticker: str, as_of: date, td: dict,
                  macro: dict, etfs: dict) -> Optional[dict]:
    as_of_str = as_of.strftime('%Y-%m-%d')
    hist      = _trunc(td['ohlcv'], as_of_str)

    if len(hist) < 60:
        return None

    current_price = hist[-1]['close']
    if not current_price:
        return None

    sm = {**td['metrics'], 'regularMarketPrice': current_price}

    etf_sym  = td['etf']
    etf_data = etfs.get(etf_sym, etfs.get('SPY', []))

    return {
        'historicalData':      hist,
        'stockMetrics':        sm,
        'macroData': {
            'vix':         _trunc(macro.get('vix', []),         as_of_str),
            'treasury10y': _trunc(macro.get('treasury10y', []), as_of_str),
            'treasury3m':  _trunc(macro.get('treasury3m', []),  as_of_str),
            'hyg':         _trunc(macro.get('hyg', []),         as_of_str),
            'lqd':         _trunc(macro.get('lqd', []),         as_of_str),
            'dxy':         _trunc(macro.get('dxy', []),         as_of_str),
            'spy':         _trunc(macro.get('spy', []),         as_of_str),
            'wti':         _trunc(macro.get('wti', []),         as_of_str),
            'copper':      _trunc(macro.get('copper', []),      as_of_str),
            'wheat':       _trunc(macro.get('wheat', []),       as_of_str),
            'sectorEtf':   {'ticker': etf_sym, 'data': _trunc(etf_data, as_of_str)},
            'worldBank':   None,
        },
        'optionsData':         {},
        'featureMetrics': {
            'ratingUp30d': 0, 'ratingDown30d': 0,
            'ratingUp90d': 0, 'ratingDown90d': 0,
            'upgradeScore30d': 0.0, 'upgradeScore90d': 0.0,
        },
        'newsArticles':        [],
        'historicalEarnings':  [],
        'dataQuality': {
            'imputedFields': list(SECTOR_MEDIANS['_default'].keys()),
            'historyYears':  round(len(hist) / 252, 1),
        },
        'technicalScore':      0.0,
        'recommendationKey':   'hold',
        'recommendationsHistory': [],
    }


# ── Accuracy helpers ────────────────────────────────────────────────────────────
def find_actual(ohlcv: list, target: date) -> Optional[float]:
    """Nearest close on or after target date (up to 10 calendar days tolerance)."""
    target_str = target.strftime('%Y-%m-%d')
    limit_str  = (target + timedelta(days=10)).strftime('%Y-%m-%d')
    for row in ohlcv:
        if target_str <= row['date'] <= limit_str:
            return row['close']
    return None


def dir_correct(pred: float, actual: float, price_at: float, deadband: float) -> Optional[bool]:
    pred_pct = (pred    - price_at) / price_at
    act_pct  = (actual  - price_at) / price_at
    if abs(pred_pct) < deadband:
        return None          # prediction in deadband — exclude from direction calc
    pred_dir = 1 if pred_pct > 0 else -1
    act_dir  = 1 if act_pct  > 0 else -1
    return pred_dir == act_dir


def prox_pct(pred: float, actual: float) -> float:
    return max(0.0, (1 - abs(actual - pred) / actual) * 100)


# ── Core backtest loop ──────────────────────────────────────────────────────────
def run(tickers: list, start_date: date, step_days: int, quiet: bool) -> dict:
    today = date.today()

    print(f'\n{"="*60}')
    print(f'  Backtest: {len(tickers)} ticker(s)  |  {start_date} → {today}  |  step={step_days}d')
    print(f'{"="*60}\n')

    print('Step 1/3 — Fetching macro & ETF data...')
    macro, etfs = fetch_macro(start_date, quiet)

    # Snap start to the next weekday if it falls on a weekend
    while start_date.weekday() >= 5:
        start_date += timedelta(days=1)

    # Generate weekday as-of dates
    as_of_dates: list[date] = []
    d = start_date
    while d < today:
        if d.weekday() < 5:   # skip Sat/Sun
            as_of_dates.append(d)
        d += timedelta(days=step_days)

    print(f'Step 2/3 — Running predictions ({len(as_of_dates)} dates × {len(tickers)} tickers)...\n')

    results: dict = {}

    for t_idx, ticker in enumerate(tickers):
        ticker = ticker.upper()
        print(f'[{t_idx+1}/{len(tickers)}] {ticker} — fetching history...', end=' ', flush=True)
        td = fetch_ticker(ticker, start_date, quiet)
        if td is None:
            print('SKIPPED')
            continue
        print(f'{len(td["ohlcv"])} bars  |  sector: {td["sector"]}')

        predictions: list[dict] = []
        errors = 0

        for i, as_of in enumerate(as_of_dates):
            payload = build_payload(ticker, as_of, td, macro, etfs)
            if payload is None:
                continue

            try:
                res = predict(ticker, payload)
            except Exception as e:
                errors += 1
                if not quiet:
                    print(f'    {as_of}: predict error — {e}', file=sys.stderr)
                continue

            if not res:
                continue

            price_at = payload['stockMetrics']['regularMarketPrice']
            entry: dict = {
                'date':  as_of.isoformat(),
                'price': round(price_at, 2),
            }

            for h in HORIZONS:
                pred_price = res.get(f'predicted_price_{h}')
                target     = as_of + timedelta(days=HORIZON_DAYS[h])
                actual     = find_actual(td['ohlcv'], target) if target < today else None

                entry[f'pred_{h}']    = round(pred_price, 2) if pred_price else None
                entry[f'conf_{h}']    = res.get(f'confidence_score_{h}')
                entry[f'actual_{h}']  = round(actual, 2) if actual else None

                if pred_price and actual and actual > 0:
                    entry[f'prox_{h}']   = round(prox_pct(pred_price, actual), 1)
                    entry[f'err_{h}']    = round((pred_price - actual) / actual * 100, 2)
                    entry[f'dir_{h}']    = dir_correct(pred_price, actual, price_at, DIRECTION_DEADBAND[h])
                else:
                    entry[f'prox_{h}'] = None
                    entry[f'err_{h}']  = None
                    entry[f'dir_{h}']  = None

            predictions.append(entry)

            if not quiet and (i + 1) % 20 == 0:
                pct = (i + 1) / len(as_of_dates) * 100
                print(f'    {i+1}/{len(as_of_dates)} dates ({pct:.0f}%) ...', flush=True)

        # Per-ticker summary
        summary: dict = {}
        for h in HORIZONS:
            evaled    = [p for p in predictions if p[f'actual_{h}'] is not None]
            dir_vals  = [p[f'dir_{h}'] for p in evaled if p[f'dir_{h}'] is not None]
            prox_vals = [p[f'prox_{h}'] for p in evaled if p[f'prox_{h}'] is not None]
            err_vals  = [abs(p[f'err_{h}']) for p in evaled if p[f'err_{h}'] is not None]

            summary[h] = {
                'n':        len(evaled),
                'n_dir':    len(dir_vals),
                'dir_acc':  round(sum(dir_vals) / len(dir_vals) * 100, 1) if dir_vals else None,
                'avg_prox': round(sum(prox_vals) / len(prox_vals), 1)     if prox_vals else None,
                'mape':     round(sum(err_vals) / len(err_vals), 2)        if err_vals else None,
            }

        results[ticker] = {
            'sector':      td['sector'],
            'predictions': predictions,
            'summary':     summary,
            'errors':      errors,
        }
        n_eval = sum(s['n'] for s in summary.values())
        print(f'    → {len(predictions)} predictions, {n_eval} evaluable, {errors} errors')

    return results


# ── HTML report ─────────────────────────────────────────────────────────────────
def _fmt(v, suffix='', na='—'):
    return f'{v}{suffix}' if v is not None else na


def _dir_badge(v):
    if v is True:  return '<span class="badge ok">✓</span>'
    if v is False: return '<span class="badge bad">✗</span>'
    return '<span class="badge na">·</span>'


def overall_summary(results: dict) -> dict:
    """Aggregate metrics across all tickers."""
    agg: dict = {h: {'dir': [], 'prox': [], 'err': []} for h in HORIZONS}
    for tk_data in results.values():
        for h in HORIZONS:
            s = tk_data['summary'][h]
            if s['dir_acc']  is not None: agg[h]['dir'].append(s['dir_acc'])
            if s['avg_prox'] is not None: agg[h]['prox'].append(s['avg_prox'])
            if s['mape']     is not None: agg[h]['err'].append(s['mape'])

    out: dict = {}
    for h in HORIZONS:
        d = agg[h]
        out[h] = {
            'dir_acc':  round(sum(d['dir']) / len(d['dir']), 1)   if d['dir']  else None,
            'avg_prox': round(sum(d['prox']) / len(d['prox']), 1) if d['prox'] else None,
            'mape':     round(sum(d['err']) / len(d['err']), 2)   if d['err']  else None,
        }
    return out


def generate_report(results: dict, tickers: list, start_date: date,
                    step_days: int, period_label: str) -> str:
    today     = date.today()
    overall   = overall_summary(results)
    n_tickers = len(results)
    n_total   = sum(len(v['predictions']) for v in results.values())

    # ── Horizon summary cards ──────────────────────────────────────────────────
    h_cards = ''
    for h in HORIZONS:
        o = overall[h]
        dir_val  = _fmt(o['dir_acc'],  '%')
        prox_val = _fmt(o['avg_prox'], '%')
        mape_val = _fmt(o['mape'],     '%')
        h_cards += f'''
        <div class="h-card">
          <div class="h-label">{HORIZON_LABEL[h]}</div>
          <div class="h-metric">{dir_val}<span class="h-sub">dir accuracy</span></div>
          <div class="h-row"><span class="h-key">Proximity</span><span class="h-val">{prox_val}</span></div>
          <div class="h-row"><span class="h-key">Avg error</span><span class="h-val">{mape_val}</span></div>
        </div>'''

    # ── Per-ticker table rows ──────────────────────────────────────────────────
    ticker_rows = ''
    for ticker, td in results.items():
        s = td['summary']
        cells = ''
        for h in HORIZONS:
            da = _fmt(s[h]['dir_acc'],  '%')
            pr = _fmt(s[h]['avg_prox'], '%')
            cells += f'<td><span class="da">{da}</span><span class="pr">{pr}</span></td>'

        ticker_rows += f'''
        <tr class="tk-row" onclick="toggleDetail('{ticker}')">
          <td><span class="ticker-sym">{ticker}</span><span class="sector-tag">{td["sector"]}</span></td>
          <td class="center">{s["1w"]["n"]}</td>
          {cells}
          <td class="center"><button class="drill-btn" onclick="toggleDetail('{ticker}');event.stopPropagation()">Details ↓</button></td>
        </tr>
        <tr id="detail-{ticker}" class="detail-row" style="display:none">
          <td colspan="7" class="detail-cell" id="detail-cell-{ticker}"></td>
        </tr>'''

    # ── Prediction data as JSON (embedded for drill-down) ─────────────────────
    json_data = json.dumps(results, default=str)

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Backtest Report — {", ".join(tickers[:4])}{"…" if len(tickers)>4 else ""}</title>
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;font-size:14px}}
/* ── Top bar ── */
.topbar{{background:#166534;padding:14px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}}
.topbar h1{{font-size:1.15rem;font-weight:700;color:#fff}}
.topbar .run-meta{{font-size:0.75rem;color:#bbf7d0;display:flex;gap:16px;flex-wrap:wrap}}
.run-meta span{{white-space:nowrap}}
/* ── Layout ── */
.container{{max-width:1200px;margin:0 auto;padding:28px 24px 60px}}
/* ── Section label ── */
.section-label{{font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin:32px 0 12px}}
/* ── Horizon summary cards ── */
.h-grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:8px}}
.h-card{{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px 20px}}
.h-label{{font-size:0.7rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}}
.h-metric{{font-size:2rem;font-weight:800;color:#4ade80;line-height:1;margin-bottom:4px;display:flex;align-items:baseline;gap:6px}}
.h-sub{{font-size:0.68rem;font-weight:400;color:#64748b}}
.h-row{{display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid #1e293b}}
.h-row+.h-row{{border-top:none;margin-top:4px;padding-top:0}}
.h-key{{font-size:0.72rem;color:#94a3b8}}
.h-val{{font-size:0.78rem;font-weight:600;color:#e2e8f0}}
/* ── Ticker table ── */
.ticker-table{{width:100%;border-collapse:collapse;background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden}}
.ticker-table th{{background:#0f172a;color:#64748b;font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:10px 14px;text-align:left;white-space:nowrap}}
.ticker-table td{{padding:12px 14px;border-top:1px solid #0f172a;vertical-align:middle}}
.ticker-table .center{{text-align:center}}
.tk-row{{cursor:pointer;transition:background .15s}}
.tk-row:hover{{background:#243347}}
.ticker-sym{{font-weight:700;font-size:0.95rem;color:#e2e8f0;margin-right:8px}}
.sector-tag{{font-size:0.68rem;color:#64748b;background:#0f172a;padding:2px 7px;border-radius:99px}}
.da{{display:block;font-weight:700;font-size:0.88rem;color:#4ade80}}
.pr{{display:block;font-size:0.72rem;color:#64748b;margin-top:2px}}
.drill-btn{{background:#166534;color:#bbf7d0;border:none;border-radius:6px;padding:4px 12px;font-size:0.72rem;font-weight:700;cursor:pointer;white-space:nowrap}}
.drill-btn:hover{{background:#14532d}}
/* ── Detail panel ── */
.detail-cell{{padding:0!important;background:#111827}}
.detail-inner{{padding:16px 20px;overflow-x:auto}}
.detail-inner h3{{font-size:0.8rem;font-weight:700;color:#94a3b8;margin-bottom:12px}}
.pred-table{{width:100%;border-collapse:collapse;font-size:0.75rem}}
.pred-table th{{background:#0f172a;color:#475569;font-weight:600;text-transform:uppercase;font-size:0.65rem;letter-spacing:.04em;padding:7px 10px;white-space:nowrap;text-align:right}}
.pred-table th:first-child,.pred-table th:nth-child(2){{text-align:left}}
.pred-table td{{padding:7px 10px;border-top:1px solid #1e293b;text-align:right;color:#94a3b8;white-space:nowrap}}
.pred-table td:first-child,.pred-table td:nth-child(2){{text-align:left;color:#e2e8f0}}
.pred-table tr:hover td{{background:#1a2535}}
.num-up{{color:#4ade80}}
.num-dn{{color:#f87171}}
.badge{{display:inline-block;width:20px;text-align:center;border-radius:3px;font-size:0.72rem;font-weight:700;padding:1px 0}}
.badge.ok{{color:#4ade80}}
.badge.bad{{color:#f87171}}
.badge.na{{color:#475569}}
.horizon-group{{display:inline-block;border-left:2px solid #1e293b;padding-left:8px;margin-left:4px}}
.na-val{{color:#334155}}
/* ── Footer ── */
.footer{{margin-top:48px;padding-top:20px;border-top:1px solid #1e293b;font-size:0.72rem;color:#475569;text-align:center}}
@media(max-width:900px){{.h-grid{{grid-template-columns:repeat(2,1fr)}}}}
@media(max-width:600px){{.h-grid{{grid-template-columns:1fr}}}}
</style>
</head>
<body>

<div class="topbar">
  <h1>Backtest Report</h1>
  <div class="run-meta">
    <span>📅 {start_date} → {today}</span>
    <span>📊 {n_tickers} ticker(s)</span>
    <span>🔁 step = {step_days}d</span>
    <span>🧮 {n_total} total predictions</span>
    <span>🗓 generated {today}</span>
  </div>
</div>

<div class="container">

  <div class="section-label">Average accuracy across all tickers</div>
  <div class="h-grid">{h_cards}</div>

  <div class="section-label" style="margin-top:36px">Results by ticker</div>
  <table class="ticker-table">
    <thead>
      <tr>
        <th>Ticker</th>
        <th class="center">Predictions</th>
        <th>1 Week</th>
        <th>1 Month</th>
        <th>3 Months</th>
        <th>6 Months</th>
        <th></th>
      </tr>
    </thead>
    <tbody>{ticker_rows}</tbody>
  </table>

  <div class="footer">
    GrowMYStocks backtest &nbsp;·&nbsp; model: {os.getenv("MODEL_VARIANT","v5")} &nbsp;·&nbsp;
    fundamentals imputed to sector medians (no point-in-time source)
  </div>

</div>

<script>
const DATA = {json_data};

function toggleDetail(ticker) {{
  const row  = document.getElementById('detail-' + ticker);
  const cell = document.getElementById('detail-cell-' + ticker);
  if (row.style.display === 'none') {{
    row.style.display = '';
    cell.innerHTML = buildDetail(ticker);
  }} else {{
    row.style.display = 'none';
    cell.innerHTML = '';
  }}
}}

function fmt(v, suffix) {{
  if (v === null || v === undefined) return '<span class="na-val">—</span>';
  const n = parseFloat(v);
  if (!isFinite(n)) return '<span class="na-val">—</span>';
  const cls = suffix === '%' && !window._noColor ? (n >= 0 ? 'num-up' : 'num-dn') : '';
  return cls ? `<span class="${{cls}}">${{n.toFixed(2)}}${{suffix}}</span>` : n.toFixed(2) + (suffix||'');
}}

function fmtPrice(v) {{
  if (v === null || v === undefined) return '<span class="na-val">—</span>';
  return '$' + parseFloat(v).toFixed(2);
}}

function dirBadge(v) {{
  if (v === true)  return '<span class="badge ok">✓</span>';
  if (v === false) return '<span class="badge bad">✗</span>';
  return '<span class="badge na">·</span>';
}}

const HORIZONS = ['1w','1m','3m','6m'];
const H_LABELS = {{'1w':'1W','1m':'1M','3m':'3M','6m':'6M'}};

function buildDetail(ticker) {{
  const td = DATA[ticker];
  if (!td || !td.predictions || td.predictions.length === 0) {{
    return '<div class="detail-inner"><p style="color:#64748b">No predictions available.</p></div>';
  }}
  const preds = td.predictions;
  // header row per-horizon group
  let thCols = '<th>Date</th><th>Price</th>';
  for (const h of HORIZONS) {{
    thCols += `<th colspan="4" style="text-align:center;border-left:2px solid #1e293b">${{H_LABELS[h]}}</th>`;
  }}
  let th2 = '<th></th><th></th>';
  for (const h of HORIZONS) {{
    th2 += '<th style="border-left:2px solid #1e293b">Predicted</th><th>Actual</th><th>Error</th><th>Dir</th>';
  }}

  let rows = '';
  for (const p of preds) {{
    let cells = `<td>${{p.date}}</td><td>${{fmtPrice(p.price)}}</td>`;
    for (const h of HORIZONS) {{
      const border = 'style="border-left:2px solid #1e293b"';
      cells += `<td ${{border}}>${{fmtPrice(p['pred_'+h])}}</td>`;
      cells += `<td>${{fmtPrice(p['actual_'+h])}}</td>`;
      const err = p['err_'+h];
      cells += `<td>${{fmt(err,'%')}}</td>`;
      cells += `<td>${{dirBadge(p['dir_'+h])}}</td>`;
    }}
    rows += `<tr>${{cells}}</tr>`;
  }}

  return `
    <div class="detail-inner">
      <h3>${{ticker}} — ${{preds.length}} prediction dates &nbsp;·&nbsp; sector: ${{td.sector}}</h3>
      <table class="pred-table">
        <thead><tr>${{thCols}}</tr><tr>${{th2}}</tr></thead>
        <tbody>${{rows}}</tbody>
      </table>
    </div>`;
}}
</script>
</body>
</html>'''


# ── Entry point ─────────────────────────────────────────────────────────────────
def main():
    args = parse_args()

    if args.random_n and args.tickers:
        raise SystemExit('error: --random cannot be combined with explicit ticker arguments.')
    if not args.random_n and not args.tickers:
        raise SystemExit('error: provide at least one ticker or use --random N.')

    if args.random_n:
        tickers = sample_diverse(args.random_n, seed=args.seed)
        seed_note = f'  seed={args.seed}' if args.seed is not None else '  (no seed — rerun for different picks)'
        print(f'\n--random {args.random_n}: selected {len(tickers)} tickers{seed_note}')
        # Show breakdown by sector + cap
        pool_lookup: Dict[str, tuple] = {}
        for sector, caps in TICKER_POOL.items():
            for cap, ts in caps.items():
                for t in ts:
                    pool_lookup[t] = (sector, cap)
        by_sector: Dict[str, List[str]] = {}
        for t in tickers:
            s, c = pool_lookup.get(t, ('Unknown', 'unknown'))
            by_sector.setdefault(s, []).append(f'{t}({c[0].upper()})')
        for s, items in sorted(by_sector.items()):
            print(f'  {s}: {", ".join(items)}')
        print()
    else:
        tickers = [t.upper() for t in args.tickers[:100]]

    start_date = resolve_start_date(args)
    step_days  = max(1, args.step)

    period_label = args.period if args.period else f'from {args.start}'

    # Default output path
    if args.output:
        out_path = Path(args.output)
    else:
        reports_dir = PROJECT_ROOT / 'reports'
        reports_dir.mkdir(exist_ok=True)
        out_path = reports_dir / f'backtest_{date.today().isoformat()}.html'

    out_path.parent.mkdir(parents=True, exist_ok=True)

    results = run(tickers, start_date, step_days, args.quiet)

    if not results:
        print('\nNo results — all tickers were skipped.')
        sys.exit(1)

    print(f'\nStep 3/3 — Generating report...')
    html = generate_report(results, tickers, start_date, step_days, period_label)
    out_path.write_text(html, encoding='utf-8')
    print(f'\n✓ Report saved → {out_path}')
    print(f'  Open with: xdg-open "{out_path}" or drag into a browser.\n')


if __name__ == '__main__':
    main()
