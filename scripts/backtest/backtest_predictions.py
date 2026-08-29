#!/usr/bin/env python3
"""
backtest_predictions.py — Simulate a stock-prediction run as of a past date.

Runs the exact same model used in production (predict() from
predict_weighted_analysis.py, unmodified) on point-in-time historical data,
then inserts a backdated row into prediction_records with predicted_at set
to the historical as-of date. Because resolve_predictions.py's resolution
logic only depends on `predicted_at + horizon_days < CURDATE()` — not on
when the row was actually inserted — any horizon whose target date has
already elapsed in real life can be resolved immediately using the actual
historical close. That means /api/analytics/model-accuracy can show real
numbers today instead of waiting up to a year for predictions made today
to mature.

CONSTRAINT: predict_weighted_analysis.py itself must stay network-free.
This script does all the yfinance fetching and hands predict() a plain
JSON-shaped dict, exactly like the live /api/stock_data and /api/prediction
routes do.

Lookahead-bias handling:
  - OHLCV and macro/benchmark time series (VIX, Treasury yields, HYG/LQD,
    DXY, SPY, sector ETF, WTI/copper/wheat) are truncated to rows on or
    before the as-of date, so the model only ever sees what would have
    actually been available at that point in time.
  - Fields yfinance only exposes as a *current* snapshot — fundamentals,
    analyst targets, options/IV, short interest, insider 90-day window,
    EPS revision velocity, institutional-ownership delta — have no free
    point-in-time history. Fundamentals are neutralized to sector-median
    (mirrors SECTOR_MEDIANS in src/app/api/stock_data/[ticker]/data/route.ts);
    everything else falls back to the model's own built-in neutral
    defaults. Backtested accuracy therefore reflects a model that lacked
    those signals, not the full live model.

Usage:
    python3 backtest_predictions.py AAPL MSFT --as-of-date 2024-01-15
    python3 backtest_predictions.py AAPL --start-date 2022-01-01 --end-date 2024-01-01 --step-days 30
    python3 backtest_predictions.py AAPL --as-of-date 2024-01-15 --dry-run
    python3 backtest_predictions.py AAPL --from-date 2025-01-01           # every trading day since, capped at 1y
    python3 backtest_predictions.py AAPL --from-date 2025-01-01 --max-days 180
"""
import math
import os
import sys
import argparse
import mysql.connector
from mysql.connector import Error
from datetime import datetime, date, timedelta
import yfinance as yf
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
# .env.local overrides so the backtest uses the same model version Next.js dev
# does — otherwise .env.production's USE_LEGACY=true silently routes to the
# legacy baseline model instead of v3-split.
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

# scripts/ is the parent of this file's directory (scripts/backtest/) — add it
# so predict_weighted_analysis and predict_weighted_analysis_baseline are importable.
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))

# Model toggle — honors the same env var the /api/prediction/[ticker] route
# uses, so a single switch in .env.local controls both the UI prediction
# button AND offline backtests. Default (unset / anything other than "true")
# = v3-split + cross-sectional long-term. "true" = frozen pre-refactor
# baseline (monolithic 4-output MLP).
_USE_LEGACY_PREDICTION = os.getenv('USE_LEGACY_PREDICTION_MODEL', '').lower() == 'true'
if _USE_LEGACY_PREDICTION:
    from predict_weighted_analysis_baseline import predict, _sanitize_predictions
    MODEL_VERSION = 'legacy'
else:
    from predict_weighted_analysis import predict, _sanitize_predictions
    MODEL_VERSION = 'v3split'
_TAG_OVERRIDE = os.getenv('MODEL_VERSION_TAG', '').strip()
if _TAG_OVERRIDE:
    MODEL_VERSION = _TAG_OVERRIDE
print(f"[backtest] Model: {MODEL_VERSION} (USE_LEGACY_PREDICTION_MODEL={'true' if _USE_LEGACY_PREDICTION else 'false'}, "
      f"CS_MODEL_VERSION={os.getenv('CS_MODEL_VERSION', 'v1')})", file=sys.stderr)

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

HORIZONS = [('1w', 7), ('1m', 30), ('3m', 91), ('6m', 180)]

# ---------------------------------------------------------------------------
# Mirrors SECTOR_MEDIANS / SECTOR_ETF in
# src/app/api/stock_data/[ticker]/data/route.ts. Used to neutralize
# fundamentals that only exist as today's snapshot (see module docstring).
# ---------------------------------------------------------------------------
SECTOR_MEDIANS = {
    'Technology':              {'peRatio': 28.0, 'pbRatio': 6.0, 'profitMargins': 0.20, 'revenueGrowth': 0.10, 'debtToEquity': 50,  'returnOnEquity': 0.25},
    'Healthcare':              {'peRatio': 22.0, 'pbRatio': 4.0, 'profitMargins': 0.12, 'revenueGrowth': 0.07, 'debtToEquity': 60,  'returnOnEquity': 0.15},
    'Financials':              {'peRatio': 12.0, 'pbRatio': 1.2, 'profitMargins': 0.20, 'revenueGrowth': 0.05, 'debtToEquity': 200, 'returnOnEquity': 0.12},
    'Financial Services':      {'peRatio': 12.0, 'pbRatio': 1.2, 'profitMargins': 0.20, 'revenueGrowth': 0.05, 'debtToEquity': 200, 'returnOnEquity': 0.12},
    'Consumer Cyclical':       {'peRatio': 20.0, 'pbRatio': 3.5, 'profitMargins': 0.07, 'revenueGrowth': 0.06, 'debtToEquity': 80,  'returnOnEquity': 0.18},
    'Consumer Defensive':      {'peRatio': 18.0, 'pbRatio': 3.0, 'profitMargins': 0.08, 'revenueGrowth': 0.04, 'debtToEquity': 70,  'returnOnEquity': 0.15},
    'Industrials':             {'peRatio': 18.0, 'pbRatio': 3.0, 'profitMargins': 0.09, 'revenueGrowth': 0.06, 'debtToEquity': 90,  'returnOnEquity': 0.16},
    'Energy':                  {'peRatio': 12.0, 'pbRatio': 1.8, 'profitMargins': 0.10, 'revenueGrowth': 0.04, 'debtToEquity': 50,  'returnOnEquity': 0.12},
    'Utilities':               {'peRatio': 16.0, 'pbRatio': 1.5, 'profitMargins': 0.12, 'revenueGrowth': 0.03, 'debtToEquity': 120, 'returnOnEquity': 0.10},
    'Real Estate':             {'peRatio': 30.0, 'pbRatio': 2.0, 'profitMargins': 0.25, 'revenueGrowth': 0.05, 'debtToEquity': 100, 'returnOnEquity': 0.08},
    'Communication Services':  {'peRatio': 20.0, 'pbRatio': 3.5, 'profitMargins': 0.15, 'revenueGrowth': 0.07, 'debtToEquity': 70,  'returnOnEquity': 0.18},
    'Basic Materials':         {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
    'Materials':               {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
    '_default':                {'peRatio': 20.0, 'pbRatio': 3.0, 'profitMargins': 0.12, 'revenueGrowth': 0.06, 'debtToEquity': 75,  'returnOnEquity': 0.15},
}

SECTOR_ETF = {
    'Technology': 'XLK', 'Healthcare': 'XLV', 'Financials': 'XLF',
    'Financial Services': 'XLF', 'Consumer Cyclical': 'XLY', 'Consumer Defensive': 'XLP',
    'Industrials': 'XLI', 'Energy': 'XLE', 'Utilities': 'XLU', 'Real Estate': 'XLRE',
    'Basic Materials': 'XLB', 'Materials': 'XLB', 'Communication Services': 'XLC',
}

MACRO_SYMBOLS = {
    'vix': '^VIX', 'treasury10y': '^TNX', 'treasury3m': '^IRX',
    'hyg': 'HYG', 'lqd': 'LQD', 'dxy': 'DX-Y.NYB', 'spy': 'SPY',
    'wti': 'CL=F', 'copper': 'HG=F', 'wheat': 'ZW=F',
}

_macro_cache = {}
_info_cache = {}
# Point-in-time PE snapshots keyed by ticker → list of (snapshot_date_str, log_ratio)
# sorted ascending by date. Populated lazily on first query per ticker so a
# multi-date backtest fires exactly one query per ticker, not one per as-of.
_snapshot_pe_cache: dict[str, list[tuple[str, float | None]]] = {}
_SNAPSHOT_FEATURE_SET = os.getenv('PIT_FEATURE_SET_VERSION', 'green_v3')


def _load_snapshot_pe_history(conn, ticker: str) -> list[tuple[str, float | None]]:
    """Pull all PE_LogRatio_vs_Sector snapshots for a ticker (once per run) and
    cache the sorted list so subsequent as-of lookups are in-memory bisects.
    Returns [] if the ticker has no snapshots — callers should fall back to None."""
    if ticker in _snapshot_pe_cache:
        return _snapshot_pe_cache[ticker]
    rows: list[tuple[str, float | None]] = []
    if conn is not None:
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT snapshot_date,
                       JSON_EXTRACT(features_json, '$.PE_LogRatio_vs_Sector')
                FROM ranking_training_snapshots
                WHERE ticker = %s AND feature_set_version = %s
                ORDER BY snapshot_date ASC
                """,
                (ticker, _SNAPSHOT_FEATURE_SET),
            )
            for snap_date, log_ratio in cur.fetchall():
                # snap_date comes back as a date object; JSON_EXTRACT gives a
                # string that may be 'null'.
                try:
                    val = float(log_ratio) if log_ratio not in (None, 'null') else None
                except (TypeError, ValueError):
                    val = None
                rows.append((snap_date.isoformat() if hasattr(snap_date, 'isoformat') else str(snap_date), val))
            cur.close()
        except Exception as exc:
            print(f"  [warn] snapshot PE lookup failed for {ticker}: {exc}")
    _snapshot_pe_cache[ticker] = rows
    return rows


def get_pe_log_ratio_at(conn, ticker: str, as_of: str) -> float | None:
    """Nearest snapshot on or before as_of. Uses bisect on the cached ascending
    list. Weekly cadence means the returned value is up to ~7 days stale
    (vastly better than 'today's live PE applied retroactively', though not
    strictly point-in-time daily)."""
    hist = _load_snapshot_pe_history(conn, ticker)
    if not hist:
        return None
    import bisect
    idx = bisect.bisect_right([d for d, _ in hist], as_of) - 1
    if idx < 0:
        return None
    return hist[idx][1]


def get_db_connection():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT, autocommit=False,
    )


def get_ticker_info(ticker: str) -> dict:
    """Cached wrapper around yf.Ticker(ticker).info. Returns {} on failure so
    callers can .get() defensively. Note: yfinance's info dict is *today's*
    snapshot — sector/industry are stable, but market_cap/beta/PE reflect
    current values, not point-in-time. See Category 4 docstring in
    prediction_details migration."""
    if ticker in _info_cache:
        return _info_cache[ticker]
    info = {}
    try:
        info = yf.Ticker(ticker).info or {}
    except Exception as exc:
        print(f"  [warn] Could not fetch info for {ticker}: {exc}")
    _info_cache[ticker] = info
    return info


def get_sector(ticker: str) -> str:
    info = get_ticker_info(ticker)
    return info.get('sector') or '_default'


def _bucket_market_cap(market_cap):
    if market_cap is None:
        return None
    if market_cap < 2_000_000_000:
        return 'small'
    if market_cap < 10_000_000_000:
        return 'mid'
    if market_cap < 200_000_000_000:
        return 'large'
    return 'mega'


def _rsi(closes, period=14):
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(-period, 0):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _last_close_on_or_before(series, as_of_str):
    rows = [r for r in series if r['date'] <= as_of_str]
    return rows[-1]['close'] if rows else None


def _return_over_trailing(series, as_of_str, days):
    """Return the pct change over the trailing `days` calendar-day window
    ending at as_of. Uses closes at endpoint of the window; if fewer than
    `days` rows exist on/before as_of, returns None."""
    rows = [r for r in series if r['date'] <= as_of_str]
    if len(rows) < days + 1:
        return None
    return (rows[-1]['close'] / rows[-days - 1]['close']) - 1.0


def compute_prediction_details(ticker: str, hist_trunc: list, macro_full: dict,
                               as_of: str, sector: str, conn=None) -> dict:
    """Compute all Category 1-4 detail fields at the as-of date. Point-in-time
    for price/macro series; snapshot proxy for info dict fields (see docstring
    on get_ticker_info). PE is pulled point-in-time from
    ranking_training_snapshots (log-ratio vs sector) when conn is provided;
    the raw pe_ratio + sector_median_pe columns are intentionally NULL for
    backtests because yfinance only exposes today's snapshot."""
    info = get_ticker_info(ticker)
    closes = [r['close'] for r in hist_trunc]
    volumes = [r['volume'] for r in hist_trunc]
    price_now = closes[-1]

    # --- Category 1: stock characteristics (snapshot proxy from info dict) ---
    market_cap = info.get('marketCap')
    industry = info.get('industry')
    beta = info.get('beta')
    dividend_yield = info.get('dividendYield')
    avg_vol_30d = sum(volumes[-30:]) / min(30, len(volumes)) if volumes else None

    # --- Category 3: stock's own state (point-in-time from hist_trunc) ---
    stock_return_30d = (closes[-1] / closes[-31] - 1.0) if len(closes) >= 31 else None
    stock_return_90d = (closes[-1] / closes[-91] - 1.0) if len(closes) >= 91 else None

    realized_vol_30d = None
    if len(closes) >= 31:
        recent = closes[-31:]
        rets = [math.log(recent[i] / recent[i - 1]) for i in range(1, len(recent))]
        if len(rets) > 1:
            mean = sum(rets) / len(rets)
            var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
            realized_vol_30d = math.sqrt(var) * math.sqrt(252)

    window_252 = closes[-252:] if len(closes) >= 252 else closes
    high_52w = max(window_252) if window_252 else None
    pct_from_52w_high = (price_now / high_52w - 1.0) if high_52w else None

    rsi_14d = _rsi(closes, 14)

    # --- Category 2: market regime (point-in-time from macro_full) ---
    vix_at_prediction = _last_close_on_or_before(macro_full.get('vix') or [], as_of)
    spy_return_30d = _return_over_trailing(macro_full.get('spy') or [], as_of, 30)

    sector_etf_series = macro_full.get('sectorEtf') or []
    # macro_full['sectorEtf'] may be wrapped as {'ticker', 'data'} in build_input_data,
    # but at compute-time we take the raw list passed in from the per-ticker macro dict.
    if isinstance(sector_etf_series, dict):
        sector_etf_series = sector_etf_series.get('data') or []
    sector_etf_return_30d = _return_over_trailing(sector_etf_series, as_of, 30)

    treasury10y = _last_close_on_or_before(macro_full.get('treasury10y') or [], as_of)
    treasury3m = _last_close_on_or_before(macro_full.get('treasury3m') or [], as_of)
    yield_curve_spread = (treasury10y - treasury3m) if (treasury10y is not None and treasury3m is not None) else None

    # --- Category 4: fundamentals point-in-time ---
    # pe_ratio + sector_median_pe are intentionally NULL for backtests — yfinance
    # only exposes today's snapshot, so populating them retroactively would leak
    # future data. The pe_log_ratio_vs_sector below is the point-in-time signal
    # pulled from ranking_training_snapshots and is what valuation_bucket()
    # thresholds against in backtest_results.py.
    pe_ratio = None
    sector_median_pe = None
    pe_log_ratio_vs_sector = get_pe_log_ratio_at(conn, ticker, as_of)
    revenue_growth = info.get('revenueGrowth')
    profit_margin = info.get('profitMargins')

    return {
        'market_cap':            market_cap,
        'market_cap_bucket':     _bucket_market_cap(market_cap),
        'industry':              industry,
        'beta_snapshot':         beta,
        'avg_daily_volume_30d':  avg_vol_30d,
        'dividend_yield':        dividend_yield,
        'vix_at_prediction':     vix_at_prediction,
        'spy_return_30d':        spy_return_30d,
        'yield_curve_spread':    yield_curve_spread,
        'sector_etf_return_30d': sector_etf_return_30d,
        'stock_return_30d':      stock_return_30d,
        'stock_return_90d':      stock_return_90d,
        'realized_vol_30d':      realized_vol_30d,
        'pct_from_52w_high':     pct_from_52w_high,
        'rsi_14d':               rsi_14d,
        'pe_ratio':              pe_ratio,
        'sector_median_pe':      sector_median_pe,
        'pe_log_ratio_vs_sector': pe_log_ratio_vs_sector,
        'revenue_growth':        revenue_growth,
        'profit_margin':         profit_margin,
    }


DETAIL_COLUMNS = [
    'market_cap', 'market_cap_bucket', 'industry', 'beta_snapshot',
    'avg_daily_volume_30d', 'dividend_yield',
    'vix_at_prediction', 'spy_return_30d', 'yield_curve_spread', 'sector_etf_return_30d',
    'stock_return_30d', 'stock_return_90d', 'realized_vol_30d', 'pct_from_52w_high', 'rsi_14d',
    'pe_ratio', 'sector_median_pe', 'pe_log_ratio_vs_sector', 'revenue_growth', 'profit_margin',
    'mlp_1w_base_raw', 'traj_anchor_1w_base', 'short_term_path',
]


def fetch_history(ticker: str, start: date, end: date) -> list:
    """Full daily OHLCV history (adjusted), ascending, as a list of dicts."""
    try:
        df = yf.Ticker(ticker).history(start=start.isoformat(), end=end.isoformat(), auto_adjust=True)
    except Exception as e:
        print(f'  [fetch_history] yfinance error for {ticker}: {e}', flush=True)
        return []
    if df.empty:
        return []
    df = df.reset_index()
    df['Date'] = df['Date'].dt.strftime('%Y-%m-%d')
    return [
        {
            'date':   r['Date'],
            'open':   float(r['Open']),
            'high':   float(r['High']),
            'low':    float(r['Low']),
            'close':  float(r['Close']),
            'volume': float(r['Volume']),
        }
        for _, r in df.iterrows()
    ]


def fetch_rating_history(ticker: str) -> list:
    """Fetch the ticker's full upgradeDowngradeHistory from Yahoo. Returns a
    list of {'firm', 'action', 'fromGrade', 'toGrade', 'epochGradeDate'}
    dicts, or empty list on failure. Yahoo retains this history indefinitely
    so we can safely filter by as-of date to compute point-in-time counts."""
    try:
        ticker_obj = yf.Ticker(ticker)
        # yfinance exposes upgrades_downgrades as a DataFrame
        df = ticker_obj.upgrades_downgrades
        if df is None or df.empty:
            return []
        # yfinance returns { 'GradeDate' index, 'Firm', 'ToGrade', 'FromGrade', 'Action' }
        rows = []
        for idx, r in df.iterrows():
            try:
                # Convert to epoch seconds
                if hasattr(idx, 'timestamp'):
                    epoch = int(idx.timestamp())
                else:
                    epoch = int(pd.Timestamp(idx).timestamp())
            except Exception:
                continue
            act = str(r.get('Action', '')).lower()
            # Map yfinance actions to Yahoo API's 'up'/'down' shape
            if act in ('up', 'upgrade'):     action = 'up'
            elif act in ('down', 'downgrade'): action = 'down'
            elif act in ('init', 'initiate'):  action = 'init'
            elif act in ('reit', 'reiterate'): action = 'reit'
            elif act in ('main', 'maintain'):  action = 'main'
            else: action = act
            rows.append({
                'firm':           str(r.get('Firm', '')),
                'action':         action,
                'fromGrade':      str(r.get('FromGrade', '')),
                'toGrade':        str(r.get('ToGrade', '')),
                'epochGradeDate': epoch,
            })
        return rows
    except Exception as exc:
        print(f"  [rating] fetch failed for {ticker}: {exc}", file=sys.stderr)
        return []


def fetch_macro_series(symbol: str, start: date, end: date) -> list:
    """List of {date, close} dicts for a macro/benchmark symbol, ascending."""
    cache_key = (symbol, start, end)
    if cache_key in _macro_cache:
        return _macro_cache[cache_key]
    rows = []
    try:
        df = yf.Ticker(symbol).history(start=start.isoformat(), end=end.isoformat(), auto_adjust=True)
        if not df.empty:
            df = df.reset_index()
            df['Date'] = df['Date'].dt.strftime('%Y-%m-%d')
            rows = [{'date': r['Date'], 'close': float(r['Close'])} for _, r in df.iterrows()]
    except Exception as exc:
        print(f"  [warn] Could not fetch macro series {symbol}: {exc}")
    _macro_cache[cache_key] = rows
    return rows


def truncate_series(rows: list, as_of: str) -> list:
    return [r for r in rows if r['date'] <= as_of]


def build_input_data(sector: str, hist_trunc: list, macro_full: dict, as_of: str,
                     rating_hist: list | None = None) -> dict:
    price_at_prediction = hist_trunc[-1]['close']
    medians = SECTOR_MEDIANS.get(sector, SECTOR_MEDIANS['_default'])

    stock_metrics = {
        'regularMarketPrice':  price_at_prediction,
        'sector':              sector,
        'peRatio':             medians['peRatio'],
        'pbRatio':             medians['pbRatio'],
        'profitMargins':       medians['profitMargins'],
        'revenueGrowth':       medians['revenueGrowth'],
        'debtToEquity':        medians['debtToEquity'],
        'returnOnEquity':      medians['returnOnEquity'],
        'trailingEps':         0.0,
        'forwardEps':          0.0,
        'earningsGrowth':      0.0,
        'beta':                1.0,
        'dividendYield':       0.0,
        'analystTargetMean':   0.0,
        'analystOpinionCount': 0,
        'recommendationMean':  3.0,
        'recommendationKey':   None,
        'nextEarningsDate':    None,
        'lastEarningsDate':    None,
        # Phase 2 (Tier 2) — sector medians surface for the log-ratio features.
        # Since we impute the raw fundamentals to the sector median, the log
        # ratios will land at 0 by construction (a stock at "sector median" =
        # log(1) = 0). Real signal only kicks in when Yahoo snapshots are
        # available live. This is an acknowledged backtest limitation.
        'sectorMedianPe':            medians['peRatio'],
        'sectorMedianPb':            medians['pbRatio'],
        'sectorMedianRevenueGrowth': medians['revenueGrowth'],
        'sectorMedianProfitMargins': medians['profitMargins'],
    }

    # Phase 2 (Tier 1) — analyst rating velocity, filtered to as-of date so
    # we don't leak future rating actions into a backtest snapshot. Yahoo's
    # upgradeDowngradeHistory returns actions with epochGradeDate; caller
    # fetches once at the outer loop and passes it in via rating_hist.
    import datetime as _dt
    _rating_metrics = {}
    if rating_hist:
        as_of_ts = _dt.datetime.strptime(as_of, '%Y-%m-%d').timestamp()
        S30 = 30 * 86400
        S90 = 90 * 86400
        past = [h for h in rating_hist if (h.get('epochGradeDate') or 0) <= as_of_ts]
        r30 = [h for h in past if as_of_ts - h.get('epochGradeDate', 0) <= S30]
        r90 = [h for h in past if as_of_ts - h.get('epochGradeDate', 0) <= S90]
        _rating_metrics = {
            'ratingUp30d':   sum(1 for h in r30 if h.get('action') == 'up'),
            'ratingDown30d': sum(1 for h in r30 if h.get('action') == 'down'),
            'ratingUp90d':   sum(1 for h in r90 if h.get('action') == 'up'),
            'ratingDown90d': sum(1 for h in r90 if h.get('action') == 'down'),
        }
        _up30 = _rating_metrics['ratingUp30d']; _dn30 = _rating_metrics['ratingDown30d']
        _up90 = _rating_metrics['ratingUp90d']; _dn90 = _rating_metrics['ratingDown90d']
        _rating_metrics['upgradeScore30d'] = ((_up30 - _dn30) / (_up30 + _dn30)) if (_up30 + _dn30) > 0 else 0.0
        _rating_metrics['upgradeScore90d'] = ((_up90 - _dn90) / (_up90 + _dn90)) if (_up90 + _dn90) > 0 else 0.0

    sector_etf_sym = SECTOR_ETF.get(sector, 'SPY')
    macro_data = {
        'vix':         truncate_series(macro_full['vix'], as_of),
        'treasury10y': truncate_series(macro_full['treasury10y'], as_of),
        'treasury3m':  truncate_series(macro_full['treasury3m'], as_of),
        'hyg':         truncate_series(macro_full['hyg'], as_of),
        'lqd':         truncate_series(macro_full['lqd'], as_of),
        'dxy':         truncate_series(macro_full['dxy'], as_of),
        'spy':         truncate_series(macro_full['spy'], as_of),
        'wti':         truncate_series(macro_full['wti'], as_of),
        'copper':      truncate_series(macro_full['copper'], as_of),
        'wheat':       truncate_series(macro_full['wheat'], as_of),
        'sectorEtf':   {'ticker': sector_etf_sym, 'data': truncate_series(macro_full['sectorEtf'], as_of)},
        'worldBank':   None,
    }

    return {
        'historicalData':     hist_trunc,
        'stockMetrics':       stock_metrics,
        'macroData':          macro_data,
        'optionsData':        {},
        'featureMetrics':     _rating_metrics,
        'newsArticles':       [],
        'historicalEarnings': [],
        'dataQuality': {
            'imputedFields': ['peRatio', 'pbRatio', 'profitMargins', 'revenueGrowth', 'debtToEquity', 'returnOnEquity'],
            'historyYears':  round(len(hist_trunc) / 252, 1),
        },
        'technicalScore':    0.0,
        'recommendationKey': None,
    }


def find_actual_price(full_hist: list, target_date: date):
    """First close on/after target_date within a 6-day window (mirrors
    resolve_predictions.get_trading_day_price). None if not yet available."""
    target_str = target_date.isoformat()
    window_end = (target_date + timedelta(days=6)).isoformat()
    for row in full_hist:
        if target_str <= row['date'] < window_end:
            return row['close']
    return None


# Per-horizon direction deadbands — mirrors resolve_predictions.py and
# predict_weighted_analysis.py. 1m raised to 3% to exclude noisy small-move
# LSTM calls from the direction metric.
DIRECTION_DEADBAND_PCT = {
    '1w': 0.02,
    '1m': 0.02,
    '3m': 0.02,
    '6m': 0.02,
}
_DEFAULT_DEADBAND = 0.02


def _direction_correct_for(predicted_price: float, actual_price: float,
                            price_at_prediction: float, deadband: float) -> int | None:
    """Shared direction logic: returns 1/0/None (None = deadband neutral)."""
    if price_at_prediction > 0:
        if abs((predicted_price - price_at_prediction) / price_at_prediction) < deadband:
            return None
    pred_dir = 1 if predicted_price > price_at_prediction else (0 if predicted_price < price_at_prediction else -1)
    act_dir  = 1 if actual_price  > price_at_prediction else (0 if actual_price  < price_at_prediction else -1)
    if pred_dir == -1 or act_dir == -1:
        return 0
    return 1 if pred_dir == act_dir else 0


def compute_accuracy_metrics(actual_price: float, predicted_price: float, price_at_prediction: float,
                              horizon: str = '', predicted_price_raw: float | None = None):
    """Mirrors resolve_predictions.compute_accuracy_metrics exactly, so
    backtested and naturally-resolved rows are scored identically.

    Returns (accuracy_pct, direction_correct, direction_correct_raw) where
    direction_correct / direction_correct_raw are:
      1    — predicted and actual moved same direction
      0    — predicted and actual moved opposite directions
      None — predicted move was inside the deadband (‘neutral’ call); the
             row is resolved for proximity but excluded from the direction
             metric downstream.
    direction_correct_raw is None when predicted_price_raw is not supplied."""
    if predicted_price == 0:
        accuracy_pct = 0.0
    else:
        accuracy_pct = max(0, (1 - abs(actual_price - predicted_price) / predicted_price) * 100)

    deadband = DIRECTION_DEADBAND_PCT.get(horizon, _DEFAULT_DEADBAND)
    direction_correct     = _direction_correct_for(predicted_price, actual_price, price_at_prediction, deadband)
    direction_correct_raw = (
        _direction_correct_for(predicted_price_raw, actual_price, price_at_prediction, deadband)
        if predicted_price_raw is not None else None
    )

    return round(accuracy_pct, 2), direction_correct, direction_correct_raw


def upsert_backtest_row(conn, row: dict, overwrite: bool):
    """Insert a backdated prediction_records row. Returns (status, record_id)
    where status is inserted/updated/skipped/error and record_id is the
    prediction_records.id (None on skipped/error)."""
    cursor = conn.cursor(buffered=True)
    try:
        cursor.execute(
            "SELECT id FROM prediction_records WHERE symbol = %s AND predicted_at = %s AND model_version = %s",
            (row['symbol'], row['predicted_at'], MODEL_VERSION),
        )
        existing = cursor.fetchone()

        if existing and not overwrite:
            return 'skipped', None

        columns = [
            'price_at_prediction',
            'predicted_price_1w', 'predicted_price_1w_raw',
            'predicted_price_1m', 'predicted_price_3m', 'predicted_price_6m',
            'predicted_change_pct_1w', 'predicted_change_pct_1m', 'predicted_change_pct_3m', 'predicted_change_pct_6m',
            'actual_price_1w', 'actual_price_1m', 'actual_price_3m', 'actual_price_6m',
            'accuracy_pct_1w', 'accuracy_pct_1m', 'accuracy_pct_3m', 'accuracy_pct_6m',
            'direction_correct_1w', 'direction_confidence_1w', 'direction_correct_raw_1w',
            'direction_correct_1m', 'direction_correct_3m', 'direction_correct_6m',
            'resolved_1w', 'resolved_1m', 'resolved_3m', 'resolved_6m',
            'confidence_score_1w', 'confidence_score_1m', 'confidence_score_3m', 'confidence_score_6m',
            'signal_confidence_1w', 'signal_confidence_1m', 'signal_confidence_3m', 'signal_confidence_6m',
            'precedent_confidence_1w', 'precedent_confidence_1m', 'precedent_confidence_3m', 'precedent_confidence_6m',
            'blended_confidence_1m',
        ]
        values = [row[c] for c in columns]

        if existing:
            record_id = existing[0]
            set_clause = ', '.join(f"{c} = %s" for c in columns)
            cursor.execute(
                f"UPDATE prediction_records SET {set_clause}, updated_at = NOW() WHERE id = %s",
                values + [record_id],
            )
            conn.commit()
            return 'updated', record_id
        else:
            insert_cols = ['symbol', 'predicted_at', 'model_version'] + columns
            placeholders = ', '.join(['%s'] * len(insert_cols))
            cursor.execute(
                f"INSERT INTO prediction_records ({', '.join(insert_cols)}) VALUES ({placeholders})",
                [row['symbol'], row['predicted_at'], MODEL_VERSION] + values,
            )
            record_id = cursor.lastrowid
            conn.commit()
            return 'inserted', record_id
    except Error as exc:
        conn.rollback()
        print(f"  [db] ERROR upserting {row['symbol']} {row['predicted_at']}: {exc}")
        return 'error', None
    finally:
        cursor.close()


def upsert_prediction_details(conn, prediction_record_id: int, details: dict) -> str:
    """Insert or replace a prediction_details row keyed by prediction_record_id.
    Returns 'ok' or 'error'."""
    cursor = conn.cursor(buffered=True)
    try:
        cursor.execute(
            "SELECT id FROM prediction_details WHERE prediction_record_id = %s",
            (prediction_record_id,),
        )
        existing = cursor.fetchone()
        values = [details.get(c) for c in DETAIL_COLUMNS]

        if existing:
            set_clause = ', '.join(f"{c} = %s" for c in DETAIL_COLUMNS)
            cursor.execute(
                f"UPDATE prediction_details SET {set_clause} WHERE id = %s",
                values + [existing[0]],
            )
        else:
            insert_cols = ['prediction_record_id'] + DETAIL_COLUMNS
            placeholders = ', '.join(['%s'] * len(insert_cols))
            cursor.execute(
                f"INSERT INTO prediction_details ({', '.join(insert_cols)}) VALUES ({placeholders})",
                [prediction_record_id] + values,
            )
        conn.commit()
        return 'ok'
    except Error as exc:
        conn.rollback()
        print(f"  [db] ERROR upserting prediction_details for record {prediction_record_id}: {exc}")
        return 'error'
    finally:
        cursor.close()


def backtest_one(ticker: str, as_of: str, full_hist: list, macro_full: dict, conn,
                 dry_run: bool, overwrite: bool, rating_hist: list | None = None):
    """Returns the computed row dict, or None if this (ticker, as_of) was skipped."""
    as_of_date = datetime.strptime(as_of, '%Y-%m-%d').date()
    hist_trunc = [r for r in full_hist if r['date'] <= as_of]

    if len(hist_trunc) < 365:
        print(f"  [skip] {ticker} {as_of}: only {len(hist_trunc)} days of history before this date (need >= 365)")
        return None

    sector = get_sector(ticker)
    input_data = build_input_data(sector, hist_trunc, macro_full, as_of, rating_hist=rating_hist)

    try:
        result = predict(ticker, input_data)
        result = _sanitize_predictions(result)
    except Exception as exc:
        print(f"  [error] {ticker} {as_of}: prediction failed: {exc}")
        return None

    price_at_prediction = hist_trunc[-1]['close']
    row = {'symbol': ticker, 'predicted_at': as_of, 'price_at_prediction': price_at_prediction}
    summary_bits = [f"{ticker} {as_of} price={price_at_prediction:.2f}"]

    # Confidence fields — written once, outside the horizons loop.
    for h in ('1w', '1m', '3m', '6m'):
        row[f'predicted_change_pct_{h}'] = result.get(f'predicted_change_pct_{h}')
        row[f'confidence_score_{h}']     = result.get(f'confidence_score_{h}')
        row[f'signal_confidence_{h}']    = result.get(f'signal_confidence_{h}')
        row[f'precedent_confidence_{h}'] = result.get(f'precedent_confidence_{h}')
    row['blended_confidence_1m'] = result.get('blended_confidence_1m')

    # Raw 1w pre-blend and classifier fields — None when model doesn't emit them.
    row['predicted_price_1w_raw']    = result.get('predicted_price_1w_raw')
    row['direction_confidence_1w']   = result.get('direction_confidence_1w')
    row['direction_correct_raw_1w']  = None  # filled in the 1w iteration below

    for h, days_offset in HORIZONS:
        predicted_price = result.get(f'predicted_price_{h}')
        row[f'predicted_price_{h}'] = predicted_price

        target_date = as_of_date + timedelta(days=days_offset)
        actual_price = find_actual_price(full_hist, target_date)

        # Pass the raw price only for 1w so we get direction_correct_raw.
        raw_price = row['predicted_price_1w_raw'] if h == '1w' else None

        if actual_price is not None and predicted_price is not None:
            accuracy_pct, direction_correct, direction_correct_raw = compute_accuracy_metrics(
                actual_price, predicted_price, price_at_prediction, horizon=h,
                predicted_price_raw=raw_price,
            )
            row[f'actual_price_{h}']       = actual_price
            row[f'accuracy_pct_{h}']       = accuracy_pct
            row[f'direction_correct_{h}']  = direction_correct
            row[f'resolved_{h}']           = 1
            if h == '1w':
                row['direction_correct_raw_1w'] = direction_correct_raw
            raw_tag = ''
            if h == '1w' and raw_price is not None:
                raw_tag = f' raw_dir={direction_correct_raw}'
            summary_bits.append(f"{h}: pred={predicted_price:.2f} actual={actual_price:.2f} acc={accuracy_pct:.1f}%{raw_tag}")
        else:
            row[f'actual_price_{h}']       = None
            row[f'accuracy_pct_{h}']       = None
            row[f'direction_correct_{h}']  = None
            row[f'resolved_{h}']           = 0
            pred_str = f"{predicted_price:.2f}" if predicted_price is not None else "n/a"
            summary_bits.append(f"{h}: pred={pred_str} (not yet resolvable)")

    print("  " + " | ".join(summary_bits))

    details = compute_prediction_details(ticker, hist_trunc, macro_full, as_of, sector, conn=conn)
    details['mlp_1w_base_raw']      = result.get('mlp_1w_base_raw')
    details['traj_anchor_1w_base']  = result.get('traj_anchor_1w_base')
    details['short_term_path']      = result.get('short_term_path')

    if dry_run:
        print(f"  [dry-run] would upsert prediction_records + prediction_details for {ticker} {as_of}")
        _preview_bits = [f"{k}={v}" for k, v in details.items() if v is not None]
        if _preview_bits:
            print("    details: " + ", ".join(_preview_bits[:8]) + (" ..." if len(_preview_bits) > 8 else ""))
        row['_details'] = details
        return row

    status, record_id = upsert_backtest_row(conn, row, overwrite)
    if status == 'skipped':
        print(f"  [skip] {ticker} {as_of}: already backtested (use --overwrite to replace)")
        return None
    print(f"  [db] {status} {ticker} {as_of}")

    if record_id is not None:
        detail_status = upsert_prediction_details(conn, record_id, details)
        if detail_status == 'ok':
            print(f"  [db] details ok for record {record_id}")
    return row


def generate_dates(args) -> list:
    if args.as_of_date:
        return [args.as_of_date]
    start = datetime.strptime(args.start_date, '%Y-%m-%d').date()
    end = datetime.strptime(args.end_date, '%Y-%m-%d').date()
    step = timedelta(days=args.step_days)
    dates = []
    d = start
    while d <= end:
        dates.append(d.isoformat())
        d += step
    return dates


def print_summary(results: list):
    if not results:
        print("\nNo rows were backtested.")
        return
    print("\n=== Backtest summary (in-memory, this run only) ===")
    for h, _ in HORIZONS:
        resolved = [r for r in results if r[f'resolved_{h}']]
        if not resolved:
            print(f"  {h}: 0/{len(results)} resolved yet")
            continue
        avg_acc = sum(r[f'accuracy_pct_{h}'] for r in resolved) / len(resolved)
        # Rows with direction_correct=None are 'neutral' calls — excluded
        # from the direction metric, not counted wrong.
        dir_rows = [r for r in resolved if r[f'direction_correct_{h}'] is not None]
        if dir_rows:
            avg_dir = sum(r[f'direction_correct_{h}'] for r in dir_rows) / len(dir_rows) * 100
            neutral = len(resolved) - len(dir_rows)
            neutral_tag = f" ({neutral} neutral)" if neutral else ""
            blended_str = f"direction correct {avg_dir:.1f}%{neutral_tag}"
        else:
            blended_str = "all neutral"

        # 1w only: raw direction accuracy + conviction-gated accuracy.
        raw_str = ''
        if h == '1w':
            raw_dir_rows = [r for r in resolved if r.get('direction_correct_raw_1w') is not None]
            if raw_dir_rows:
                avg_raw = sum(r['direction_correct_raw_1w'] for r in raw_dir_rows) / len(raw_dir_rows) * 100
                n_raw_neutral = len(resolved) - len(raw_dir_rows)
                raw_str = f" | raw dir {avg_raw:.1f}% ({n_raw_neutral} neutral)"

            # Conviction gate: rows where p_up is outside [0.4, 0.6]
            conv_rows = [
                r for r in resolved
                if r.get('direction_confidence_1w') is not None
                and (r['direction_confidence_1w'] < 0.45 or r['direction_confidence_1w'] > 0.55)
                and r.get('direction_correct_1w') is not None
            ]
            if conv_rows:
                avg_conv = sum(r['direction_correct_1w'] for r in conv_rows) / len(conv_rows) * 100
                raw_str += (f" | conviction dir {avg_conv:.1f}% ({len(conv_rows)} calls, "
                            f"{len(resolved)-len(conv_rows)} suppressed)")

        print(f"  {h}: {len(resolved)}/{len(results)} resolved | avg accuracy {avg_acc:.1f}% | {blended_str}{raw_str}")


def print_per_ticker_summary(results: list):
    """Print a per-ticker, per-horizon table covering accuracy, directional
    accuracy, average predicted %change, and average confidence score."""
    if not results:
        return

    tickers = list(dict.fromkeys(r['symbol'] for r in results))  # preserve order
    horizons = [h for h, _ in HORIZONS]

    # Column widths
    col_ticker  = 7
    col_horizon = 4
    col_res     = 8   # "resolved"
    col_acc     = 9   # "price acc"
    col_dir     = 8   # "dir acc"
    col_raw     = 8   # "raw dir" (1w only)
    col_chg     = 10  # "avg %chg"
    col_conf    = 7   # "avg conf"

    sep = (f"{'─'*col_ticker}  {'─'*col_horizon}  {'─'*col_res}  "
           f"{'─'*col_acc}  {'─'*col_dir}  {'─'*col_raw}  {'─'*col_chg}  {'─'*col_conf}")
    hdr = (f"{'Ticker':<{col_ticker}}  {'Hrz':<{col_horizon}}  "
           f"{'Resolved':>{col_res}}  {'Price Acc':>{col_acc}}  "
           f"{'Dir Acc':>{col_dir}}  {'Raw Dir':>{col_raw}}  {'Avg %Chg':>{col_chg}}  "
           f"{'Avg Conf':>{col_conf}}")

    print("\n=== Per-ticker summary (all horizons) ===")
    print(hdr)
    print(sep)

    for ticker in tickers:
        ticker_rows = [r for r in results if r['symbol'] == ticker]
        total = len(ticker_rows)
        first = True
        for h in horizons:
            resolved = [r for r in ticker_rows if r.get(f'resolved_{h}')]
            n_res = len(resolved)

            acc_str  = '--'
            dir_str  = '--'
            raw_str  = '--'
            if resolved:
                avg_acc = sum(r[f'accuracy_pct_{h}'] for r in resolved) / n_res
                acc_str = f"{avg_acc:.1f}%"
                dir_rows = [r for r in resolved if r.get(f'direction_correct_{h}') is not None]
                neutral  = n_res - len(dir_rows)
                if dir_rows:
                    avg_dir = sum(r[f'direction_correct_{h}'] for r in dir_rows) / len(dir_rows) * 100
                    dir_str = f"{avg_dir:.0f}%"
                    if neutral:
                        dir_str += f" ({neutral}n)"
                else:
                    dir_str = 'all neut'

                # Raw direction for 1w only
                if h == '1w':
                    raw_dir_rows = [r for r in resolved if r.get('direction_correct_raw_1w') is not None]
                    if raw_dir_rows:
                        avg_raw = sum(r['direction_correct_raw_1w'] for r in raw_dir_rows) / len(raw_dir_rows) * 100
                        n_raw_n = n_res - len(raw_dir_rows)
                        raw_str = f"{avg_raw:.0f}%"
                        if n_raw_n:
                            raw_str += f" ({n_raw_n}n)"
                    elif resolved:
                        raw_str = 'no raw'

            # Predicted %change — use all rows (not just resolved) for full coverage
            chg_vals = [r.get(f'predicted_change_pct_{h}') for r in ticker_rows if r.get(f'predicted_change_pct_{h}') is not None]
            chg_str  = f"{sum(chg_vals)/len(chg_vals):+.1f}%" if chg_vals else '--'

            conf_vals = [r.get(f'confidence_score_{h}') for r in ticker_rows if r.get(f'confidence_score_{h}') is not None]
            conf_str  = f"{sum(conf_vals)/len(conf_vals):.0f}" if conf_vals else '--'

            res_str = f"{n_res}/{total}"
            ticker_label = ticker if first else ''
            first = False
            print(f"{ticker_label:<{col_ticker}}  {h:<{col_horizon}}  "
                  f"{res_str:>{col_res}}  {acc_str:>{col_acc}}  "
                  f"{dir_str:>{col_dir}}  {raw_str:>{col_raw}}  "
                  f"{chg_str:>{col_chg}}  {conf_str:>{col_conf}}")
        print(sep)


def main():
    parser = argparse.ArgumentParser(
        description='Backtest the prediction model on a historical date (or range of dates), '
                     'so model accuracy can be measured immediately instead of waiting for real time to pass.'
    )
    parser.add_argument('tickers', nargs='+', help='Stock ticker symbol(s)')
    parser.add_argument('--as-of-date', type=str, help='Single historical date to simulate (YYYY-MM-DD)')
    parser.add_argument('--from-date', type=str, help='Run one prediction per trading day from this date through today (or --max-days out, whichever is sooner)')
    parser.add_argument('--max-days', type=int, default=365, help='With --from-date, cap how many calendar days forward of that date to backtest (default: 365)')
    parser.add_argument('--start-date', type=str, help='Start of date range (YYYY-MM-DD)')
    parser.add_argument('--end-date', type=str, help='End of date range (YYYY-MM-DD)')
    parser.add_argument('--step-days', type=int, default=30, help='Days between simulated dates in a range (default: 30)')
    parser.add_argument('--lookback-years', type=int, default=5, help='Years of history to fetch before the earliest as-of date (default: 5)')
    parser.add_argument('--dry-run', action='store_true', help="Don't write to the database; just print predicted vs. actual")
    parser.add_argument('--overwrite', action='store_true', help='Replace an existing backtest row for the same (symbol, date) instead of skipping it')
    args = parser.parse_args()

    mode_count = sum([bool(args.as_of_date), bool(args.from_date), bool(args.start_date or args.end_date)])
    if mode_count != 1:
        parser.error('Provide exactly one of: --as-of-date, --from-date, or --start-date/--end-date')
    if bool(args.start_date) != bool(args.end_date):
        parser.error('--start-date and --end-date must be used together')

    today = date.today()
    as_of_dates = None
    from_date = cap_date = None

    if args.from_date:
        from_date = datetime.strptime(args.from_date, '%Y-%m-%d').date()
        if from_date >= today:
            parser.error(f'--from-date {args.from_date} must be in the past')
        cap_date = min(today - timedelta(days=1), from_date + timedelta(days=args.max_days))
        earliest_date = from_date
    else:
        as_of_dates = generate_dates(args)
        for d in as_of_dates:
            if datetime.strptime(d, '%Y-%m-%d').date() >= today:
                parser.error(f'as-of date {d} must be in the past')
        earliest_date = datetime.strptime(min(as_of_dates), '%Y-%m-%d').date()

    download_start = earliest_date - timedelta(days=365 * args.lookback_years + 30)
    download_end = today + timedelta(days=1)  # yfinance end is exclusive

    if args.from_date:
        print(f"[{datetime.now().isoformat()}] Backtesting {len(args.tickers)} ticker(s), "
              f"one prediction per trading day from {from_date.isoformat()} through {cap_date.isoformat()}...")
    else:
        print(f"[{datetime.now().isoformat()}] Backtesting {len(args.tickers)} ticker(s) x {len(as_of_dates)} date(s)...")
    print("  Lookahead-bias note: fundamentals neutralized to sector-median; "
          "options/insider/analyst-revision/institution-ownership fields neutralized to model defaults.")
    if args.dry_run:
        print("  [dry-run] No database writes will be made.")

    conn = None if args.dry_run else get_db_connection()
    all_results = []

    try:
        # Macro series are shared across tickers/dates — fetch each symbol once.
        macro_full = {key: fetch_macro_series(sym, download_start, download_end) for key, sym in MACRO_SYMBOLS.items()}
        sector_etf_cache = {}

        for ticker in args.tickers:
            ticker = ticker.upper().strip()
            print(f"\n[{ticker}] Fetching {args.lookback_years}+ years of history...")
            full_hist = fetch_history(ticker, download_start, download_end)
            if not full_hist:
                print(f"  [error] No historical data returned for {ticker}, skipping.")
                continue

            # Phase 2 (Tier 1) — pull the analyst upgrade/downgrade history once
            # per ticker. Yahoo returns every action ever recorded with epoch
            # timestamps; we filter to <= as_of at each backtest date in
            # build_input_data so no future ratings leak in.
            rating_hist = fetch_rating_history(ticker)

            sector = get_sector(ticker)
            sector_etf_sym = SECTOR_ETF.get(sector, 'SPY')
            if sector_etf_sym not in sector_etf_cache:
                sector_etf_cache[sector_etf_sym] = fetch_macro_series(sector_etf_sym, download_start, download_end)
            ticker_macro = dict(macro_full)
            ticker_macro['sectorEtf'] = sector_etf_cache[sector_etf_sym]

            if args.from_date:
                ticker_dates = [r['date'] for r in full_hist if from_date.isoformat() <= r['date'] <= cap_date.isoformat()]
                print(f"  {len(ticker_dates)} trading day(s) to backtest in range.")
            else:
                ticker_dates = as_of_dates

            for as_of in ticker_dates:
                row = backtest_one(ticker, as_of, full_hist, ticker_macro, conn, args.dry_run, args.overwrite,
                                    rating_hist=rating_hist)
                if row is not None:
                    all_results.append(row)
    finally:
        if conn is not None:
            conn.close()

    print_summary(all_results)
    print_per_ticker_summary(all_results)

    # Item 3 — LLM narrative appended to the run output when Ollama is enabled
    # and we have real data to describe (skip dry runs, --as-of-date one-shots,
    # or runs where nothing landed). Never blocks completion; run_narration()
    # itself is exit-0 safe on any Ollama failure path.
    if not args.dry_run and all_results and args.from_date:
        try:
            from backtest_narrate import run_narration
            _narr_from = args.from_date
            _narr_to   = cap_date.isoformat() if cap_date else None
            _narr_syms = [t.upper().strip() for t in args.tickers]
            narrative = run_narration(_narr_syms, MODEL_VERSION, _narr_from, _narr_to,
                                       include_prior_week=True)
            if narrative:
                print("\n=== LLM narrative ===")
                print(narrative)
        except Exception as _exc:
            # Never let a narration exception mask backtest success
            print(f"  [narrate] skipped due to internal error: {_exc}")

    print(f"\n[{datetime.now().isoformat()}] Backtest complete.")


if __name__ == '__main__':
    main()