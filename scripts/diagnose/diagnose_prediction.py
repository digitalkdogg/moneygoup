#!/usr/bin/env python3
"""
diagnose_prediction.py — Deep-dive diagnostic for a single ticker's prediction.

Fetches live data via yfinance, builds the full prediction payload, runs
predict_weighted_analysis.predict() directly (no HTTP, no cache), and prints
a structured breakdown of every signal that feeds the model.

USAGE:
    python3 scripts/diagnose/diagnose_prediction.py <TICKER> [--outlook all|1_week|1_month|6_month|1_year]

EXAMPLES:
    python3 scripts/diagnose/diagnose_prediction.py CDP
    python3 scripts/diagnose/diagnose_prediction.py AAPL --outlook 1_year
"""
from __future__ import annotations

import os
import sys
import argparse
import io
import json
import traceback
import contextlib
from datetime import datetime, timedelta

# ── CPU throttle before any TF/numpy import ─────────────────────────────────
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
os.environ.setdefault('TF_NUM_INTRAOP_THREADS', '2')
os.environ.setdefault('TF_NUM_INTEROP_THREADS', '2')
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # scripts/
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

from dotenv import load_dotenv
# Base config lives in .env; .env.production and .env.local (in that order)
# layer on top as overrides, matching Next.js's own env-file precedence.
# Previously this only loaded .env.production/.env.local, so a machine with
# just a plain .env (e.g. local dev) silently defaulted every model-version
# env var (CS_MODEL_VERSION, ST_CS_MODEL_VERSION, ...).
load_dotenv(os.path.join(PROJECT_ROOT, '.env'))
if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'), override=True)
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

# ── Colour helpers ───────────────────────────────────────────────────────────
try:
    import colorama
    colorama.init()
    R  = colorama.Fore.RED
    Y  = colorama.Fore.YELLOW
    G  = colorama.Fore.GREEN
    B  = colorama.Fore.CYAN
    M  = colorama.Fore.MAGENTA
    W  = colorama.Fore.WHITE
    DIM = colorama.Style.DIM
    BRT = colorama.Style.BRIGHT
    RST = colorama.Style.RESET_ALL
except ImportError:
    R = Y = G = B = M = W = DIM = BRT = RST = ''


def hdr(title: str, char: str = '═') -> None:
    line = char * 72
    print(f'\n{BRT}{B}{line}{RST}')
    print(f'{BRT}{B}  {title}{RST}')
    print(f'{BRT}{B}{line}{RST}')


def sub(title: str) -> None:
    print(f'\n{BRT}{W}── {title} ──{RST}')


def kv(label: str, value, width: int = 30, flag: str = '') -> None:
    col = flag if flag else W
    print(f'  {DIM}{label:<{width}}{RST}{col}{value}{RST}')


def flag_color(value: float, lo: float, hi: float, invert: bool = False) -> str:
    """Green if value is in [lo, hi], red otherwise (invert to flag high as bad)."""
    in_range = lo <= value <= hi
    if invert:
        return R if in_range else G
    return G if in_range else R


# ── Sector ETF map (mirrors the app's macro fetch) ──────────────────────────
SECTOR_ETF_MAP = {
    'Technology':            'XLK',
    'Healthcare':            'XLV',
    'Financial Services':    'XLF',
    'Financials':            'XLF',
    'Consumer Cyclical':     'XLY',
    'Consumer Defensive':    'XLP',
    'Energy':                'XLE',
    'Industrials':           'XLI',
    'Basic Materials':       'XLB',
    'Materials':             'XLB',
    'Utilities':             'XLU',
    'Real Estate':           'XLRE',
    'Communication Services':'XLC',
}

MACRO_SYMBOLS = {
    'vix':        '^VIX',
    'treasury10y': '^TNX',
    'treasury3m':  '^IRX',
    'hyg':        'HYG',
    'lqd':        'LQD',
    'dxy':        'DX-Y.NYB',
    'spy':        'SPY',
    'wti':        'CL=F',
    'copper':     'HG=F',
    'wheat':      'ZW=F',
}


def fetch_series(yf_ticker_obj, period: str = '5y') -> list[dict]:
    """Return [{date, close}] list from a yfinance Ticker."""
    try:
        hist = yf_ticker_obj.history(period=period, auto_adjust=True)
        if hist.empty:
            return []
        out = []
        for idx, row in hist.iterrows():
            date_str = idx.strftime('%Y-%m-%d') if hasattr(idx, 'strftime') else str(idx)[:10]
            out.append({'date': date_str, 'close': float(row['Close'])})
        return out
    except Exception:
        return []


def fetch_ohlcv(ticker: str, yf) -> list[dict]:
    t = yf.Ticker(ticker)
    hist = t.history(period='5y', auto_adjust=True)
    if hist.empty:
        raise ValueError(f'No OHLCV data returned for {ticker}')
    hist['Close'] = hist['Close'].replace(0, float('nan')).ffill()
    rows = []
    for idx, row in hist.iterrows():
        date_str = idx.strftime('%Y-%m-%d') if hasattr(idx, 'strftime') else str(idx)[:10]
        rows.append({
            'date':   date_str,
            'open':   float(row['Open']),
            'high':   float(row['High']),
            'low':    float(row['Low']),
            'close':  float(row['Close']),
            'volume': float(row.get('Volume', 0) or 0),
        })
    return rows


def fetch_quote_summary(ticker: str, yf):
    t = yf.Ticker(ticker)
    info = {}
    try:
        info = t.info or {}
    except Exception:
        pass
    return info, t


def fetch_macro(yf, sector: str) -> dict:
    print(f'  Fetching macro series ({len(MACRO_SYMBOLS)} symbols)...', end='', flush=True)
    macro: dict = {}
    for key, sym in MACRO_SYMBOLS.items():
        t = yf.Ticker(sym)
        series = fetch_series(t)
        macro[key] = [{'date': r['date'], 'close': r['close']} for r in series]
        print('.', end='', flush=True)

    # Sector ETF
    etf_sym = SECTOR_ETF_MAP.get(sector, 'SPY')
    etf_ticker = yf.Ticker(etf_sym)
    etf_series = fetch_series(etf_ticker)
    macro['sectorEtf'] = {
        'symbol': etf_sym,
        'data': [{'date': r['date'], 'close': r['close']} for r in etf_series],
    }
    print(f' {etf_sym} ✓')
    return macro


def build_stock_metrics(info: dict, hist_rows: list[dict]) -> dict:
    last_close = hist_rows[-1]['close'] if hist_rows else 0.0
    return {
        'regularMarketPrice':  info.get('currentPrice') or info.get('regularMarketPrice') or last_close,
        'peRatio':             info.get('trailingPE'),
        'pbRatio':             info.get('priceToBook'),
        'marketCap':           info.get('marketCap'),
        'revenueGrowth':       info.get('revenueGrowth'),
        'earningsGrowth':      info.get('earningsGrowth'),
        'recommendationKey':   info.get('recommendationKey'),
        'recommendationMean':  info.get('recommendationMean'),
        'analystOpinionCount': info.get('numberOfAnalystOpinions'),
        'analystTargetMean':   info.get('targetMeanPrice'),
        'analystTargetLow':    info.get('targetLowPrice'),
        'analystTargetHigh':   info.get('targetHighPrice'),
        'beta':                info.get('beta'),
        'sector':              info.get('sector', 'Unknown'),
        'industry':            info.get('industry', 'Unknown'),
        'trailingEps':         info.get('trailingEps'),
        'forwardEps':          info.get('forwardEps'),
        'freeCashflow':        info.get('freeCashflow'),
        'totalRevenue':        info.get('totalRevenue'),
        'ebitda':              info.get('ebitda'),
        'debtToEquity':        info.get('debtToEquity'),
        'returnOnEquity':      info.get('returnOnEquity'),
        'returnOnAssets':      info.get('returnOnAssets'),
        'profitMargins':       info.get('profitMargins'),
        'grossMargins':        info.get('grossMargins'),
        'fiftyTwoWeekHigh':    info.get('fiftyTwoWeekHigh'),
        'fiftyTwoWeekLow':     info.get('fiftyTwoWeekLow'),
        'fiftyTwoWeekChange':  info.get('52WeekChange'),
        'shortRatio':          info.get('shortRatio'),
        'shortPercentOfFloat': info.get('shortPercentOfFloat'),
        'sharesOutstanding':   info.get('sharesOutstanding'),
        'floatShares':         info.get('floatShares'),
        'dividendYield':       info.get('dividendYield'),
        'payoutRatio':         info.get('payoutRatio'),
        'currentRatio':        info.get('currentRatio'),
        'quickRatio':          info.get('quickRatio'),
        'analystUpside':       _calc_upside(info),
    }


def _calc_upside(info: dict) -> float | None:
    price = info.get('currentPrice') or info.get('regularMarketPrice')
    target = info.get('targetMeanPrice')
    if price and target and price > 0:
        return round((target - price) / price * 100, 2)
    return None


def fetch_earnings_history(t) -> list[dict]:
    try:
        eh = t.earnings_history
        if eh is None or (hasattr(eh, 'empty') and eh.empty):
            return []
        rows = []
        for _, row in eh.iterrows():
            rows.append({
                'date':      str(row.get('Earnings Date', ''))[:10],
                'estimate':  float(row['EPS Estimate']) if row.get('EPS Estimate') is not None else None,
                'actual':    float(row['Reported EPS']) if row.get('Reported EPS') is not None else None,
                'surprise':  float(row['Surprise(%)']) if row.get('Surprise(%)') is not None else None,
            })
        return rows
    except Exception:
        return []


def fetch_recommendations(t) -> list[dict]:
    try:
        recs = t.recommendations
        if recs is None or (hasattr(recs, 'empty') and recs.empty):
            return []
        rows = []
        for _, row in recs.iterrows():
            rows.append({
                'period':    str(row.get('period', '')),
                'strongBuy': int(row.get('strongBuy', 0) or 0),
                'buy':       int(row.get('buy', 0) or 0),
                'hold':      int(row.get('hold', 0) or 0),
                'sell':      int(row.get('sell', 0) or 0),
                'strongSell':int(row.get('strongSell', 0) or 0),
            })
        return rows
    except Exception:
        return []


# ── Return helpers ───────────────────────────────────────────────────────────
def period_return(closes: list[float], days: int) -> float | None:
    if len(closes) < days + 1:
        return None
    end = closes[-1]
    start = closes[-(days + 1)]
    if start == 0:
        return None
    return round((end - start) / start * 100, 2)


# ── RSI ──────────────────────────────────────────────────────────────────────
def rsi(closes: list[float], period: int = 14) -> float | None:
    import numpy as np
    if len(closes) < period + 1:
        return None
    c = np.array(closes, dtype=float)
    deltas = np.diff(c)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = gains[-period:].mean()
    avg_loss = losses[-period:].mean()
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100.0 - 100.0 / (1.0 + rs), 2)


# ── Print helpers ─────────────────────────────────────────────────────────────
def pct_color(v) -> str:
    if v is None:
        return f'{DIM}N/A{RST}'
    col = G if v >= 0 else R
    sign = '+' if v >= 0 else ''
    return f'{col}{sign}{v:.2f}%{RST}'


def conf_color(v) -> str:
    if v is None:
        return f'{DIM}N/A{RST}'
    col = G if v >= 70 else (Y if v >= 45 else R)
    return f'{col}{v}{RST}'


def price_str(v, current: float) -> str:
    if v is None:
        return f'{DIM}N/A{RST}'
    pct = (v - current) / current * 100 if current else 0
    col = G if pct >= 0 else R
    sign = '+' if pct >= 0 else ''
    return f'{col}${v:.2f} ({sign}{pct:.1f}%){RST}'


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Prediction diagnostic tool')
    parser.add_argument('ticker', type=str, help='Ticker symbol (e.g. CDP)')
    parser.add_argument('--outlook', type=str, default='all',
                        choices=['all', '1_week', '1_month', '6_month', '1_year'])
    parser.add_argument('--no-color', action='store_true', help='Disable terminal colors')
    args = parser.parse_args()

    ticker = args.ticker.upper()

    hdr(f'PREDICTION DIAGNOSTIC — {ticker}')
    print(f'  Date: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print(f'  Outlook: {args.outlook}')
    print(f'  CS_MODEL_VERSION: {os.getenv("CS_MODEL_VERSION", "v2")}')
    print(f'  MODEL_VARIANT: {os.getenv("MODEL_VARIANT", "v5")}')

    # ── Fetch data ────────────────────────────────────────────────────────────
    hdr('1. FETCHING DATA', '─')
    print(f'  Importing yfinance...')
    import yfinance as yf

    print(f'  Fetching OHLCV for {ticker} (5y)...')
    try:
        hist_rows = fetch_ohlcv(ticker, yf)
    except Exception as e:
        print(f'{R}FATAL: Could not fetch OHLCV: {e}{RST}')
        sys.exit(1)

    print(f'  Fetching quote summary...')
    info, ticker_obj = fetch_quote_summary(ticker, yf)

    sector = info.get('sector', 'Unknown')
    print(f'  Sector: {sector}')
    print(f'  Fetching macro data...')
    macro_data = fetch_macro(yf, sector)

    print(f'  Fetching earnings history...')
    earnings_hist = fetch_earnings_history(ticker_obj)

    print(f'  Fetching recommendations...')
    rec_history = fetch_recommendations(ticker_obj)

    stock_metrics = build_stock_metrics(info, hist_rows)
    current_price = float(stock_metrics.get('regularMarketPrice') or hist_rows[-1]['close'])

    data_quality = {
        'historyDays': len(hist_rows),
        'shortHistory': len(hist_rows) < 200,
    }

    input_data = {
        'historicalData':      hist_rows,
        'stockMetrics':        stock_metrics,
        'macroData':           macro_data,
        'recommendationsHistory': rec_history,
        'newsArticles':        [],
        'historicalEarnings':  earnings_hist,
        'technicalScore':      0.0,
        'dataQuality':         data_quality,
        'outlook':             args.outlook,
        'recommendationKey':   info.get('recommendationKey'),
    }

    closes = [r['close'] for r in hist_rows]

    # ── Price action ─────────────────────────────────────────────────────────
    hdr('2. RECENT PRICE ACTION', '─')
    sub('Returns')
    kv('Current price',  f'${current_price:.4f}')
    kv('History length', f'{len(hist_rows)} days ({len(hist_rows)/252:.1f} years)')
    kv('52w High',       f'${stock_metrics.get("fiftyTwoWeekHigh") or "N/A"}')
    kv('52w Low',        f'${stock_metrics.get("fiftyTwoWeekLow") or "N/A"}')

    ret_1d   = period_return(closes, 1)
    ret_5d   = period_return(closes, 5)
    ret_20d  = period_return(closes, 20)
    ret_30d  = period_return(closes, 30)
    ret_60d  = period_return(closes, 60)
    ret_90d  = period_return(closes, 90)
    ret_252d = period_return(closes, 252)

    kv('1d return',    pct_color(ret_1d))
    kv('5d return',    pct_color(ret_5d))
    kv('20d return',   pct_color(ret_20d))
    kv('30d return',   pct_color(ret_30d))
    kv('60d return',   pct_color(ret_60d))
    kv('90d return',   pct_color(ret_90d))
    kv('52w return',   pct_color(ret_252d))
    kv('52w change (Yahoo)', pct_color((stock_metrics.get('fiftyTwoWeekChange') or 0) * 100))

    if stock_metrics.get('fiftyTwoWeekHigh') and current_price:
        pct_from_high = (current_price - stock_metrics['fiftyTwoWeekHigh']) / stock_metrics['fiftyTwoWeekHigh'] * 100
        col = R if pct_from_high < -20 else (Y if pct_from_high < -10 else G)
        kv('% from 52w high',  f'{col}{pct_from_high:+.2f}%{RST}')

    # ── Technicals ───────────────────────────────────────────────────────────
    hdr('3. TECHNICAL INDICATORS', '─')
    rsi_val = rsi(closes, 14)
    rsi_col = R if (rsi_val or 50) > 70 else (R if (rsi_val or 50) < 30 else G)
    kv('RSI(14)',   f'{rsi_col}{rsi_val}{RST}' if rsi_val else f'{DIM}N/A{RST}')

    import numpy as np
    c = np.array(closes)
    if len(c) >= 200:
        sma20  = c[-20:].mean()
        sma50  = c[-50:].mean()
        sma200 = c[-200:].mean()
        kv('SMA20',   f'${sma20:.4f}  ({("+" if current_price>sma20 else "")}{(current_price-sma20)/sma20*100:.1f}% vs price)')
        kv('SMA50',   f'${sma50:.4f}  ({("+" if current_price>sma50 else "")}{(current_price-sma50)/sma50*100:.1f}% vs price)')
        kv('SMA200',  f'${sma200:.4f}  ({("+" if current_price>sma200 else "")}{(current_price-sma200)/sma200*100:.1f}% vs price)')
        death_cross = sma50 < sma200
        golden_cross = sma50 > sma200
        kv('Cross signal',  f'{"💀 Death cross (SMA50 < SMA200)" if death_cross else "✨ Golden cross (SMA50 > SMA200)"}')

    # Bollinger bands
    if len(c) >= 20:
        bb_mean = c[-20:].mean()
        bb_std  = c[-20:].std()
        bb_upper = bb_mean + 2 * bb_std
        bb_lower = bb_mean - 2 * bb_std
        bb_pos = (current_price - bb_lower) / (bb_upper - bb_lower + 1e-9)
        bb_col = R if bb_pos > 0.9 else (R if bb_pos < 0.1 else G)
        kv('Bollinger %B', f'{bb_col}{bb_pos:.2f}{RST} (0=lower band, 1=upper band)')

    beta = stock_metrics.get('beta')
    kv('Beta',   f'{beta}' if beta else f'{DIM}N/A{RST}')

    # ── Fundamentals ─────────────────────────────────────────────────────────
    hdr('4. FUNDAMENTALS', '─')
    sub('Valuation')
    kv('Market cap',   f'${(stock_metrics.get("marketCap") or 0)/1e9:.2f}B' if stock_metrics.get('marketCap') else f'{DIM}N/A{RST}')
    kv('P/E ratio',    stock_metrics.get('peRatio') or f'{DIM}N/A{RST}')
    kv('P/B ratio',    stock_metrics.get('pbRatio') or f'{DIM}N/A{RST}')
    kv('EPS (trail)',  stock_metrics.get('trailingEps') or f'{DIM}N/A{RST}')
    kv('EPS (fwd)',    stock_metrics.get('forwardEps') or f'{DIM}N/A{RST}')

    sub('Growth')
    rev_g = stock_metrics.get('revenueGrowth')
    earn_g = stock_metrics.get('earningsGrowth')
    kv('Revenue growth',  pct_color((rev_g or 0) * 100) if rev_g is not None else f'{DIM}N/A{RST}')
    kv('Earnings growth', pct_color((earn_g or 0) * 100) if earn_g is not None else f'{DIM}N/A{RST}')
    kv('ROE',  f'{(stock_metrics.get("returnOnEquity") or 0)*100:.1f}%' if stock_metrics.get('returnOnEquity') else f'{DIM}N/A{RST}')
    kv('ROA',  f'{(stock_metrics.get("returnOnAssets") or 0)*100:.1f}%' if stock_metrics.get('returnOnAssets') else f'{DIM}N/A{RST}')
    kv('Profit margin', f'{(stock_metrics.get("profitMargins") or 0)*100:.1f}%' if stock_metrics.get('profitMargins') else f'{DIM}N/A{RST}')
    kv('Gross margin',  f'{(stock_metrics.get("grossMargins") or 0)*100:.1f}%' if stock_metrics.get('grossMargins') else f'{DIM}N/A{RST}')
    kv('Free cashflow', f'${(stock_metrics.get("freeCashflow") or 0)/1e6:.1f}M' if stock_metrics.get('freeCashflow') else f'{DIM}N/A{RST}')

    sub('Analyst Coverage')
    kv('Target (mean)', f'${stock_metrics.get("analystTargetMean") or "N/A"}')
    kv('Analyst upside', pct_color(stock_metrics.get('analystUpside')))
    kv('# analysts',    stock_metrics.get('analystOpinionCount') or f'{DIM}N/A{RST}')
    kv('Recommendation', stock_metrics.get('recommendationKey') or f'{DIM}N/A{RST}')
    kv('Rec mean (1-5)', stock_metrics.get('recommendationMean') or f'{DIM}N/A{RST}')

    if rec_history:
        sub('Recommendations history (most recent period)')
        r0 = next((r for r in rec_history if r.get('period') == '0m'), rec_history[0])
        for lbl, k2 in [('Strong Buy', 'strongBuy'), ('Buy', 'buy'), ('Hold', 'hold'),
                        ('Sell', 'sell'), ('Strong Sell', 'strongSell')]:
            cnt = r0.get(k2, 0) or 0
            bar = '█' * cnt
            col = G if 'Buy' in lbl else (R if 'Sell' in lbl else Y)
            kv(lbl, f'{col}{bar} {cnt}{RST}')

    sub('Short interest')
    kv('Short ratio',     stock_metrics.get('shortRatio') or f'{DIM}N/A{RST}')
    kv('Short % float',   f'{(stock_metrics.get("shortPercentOfFloat") or 0)*100:.1f}%' if stock_metrics.get('shortPercentOfFloat') else f'{DIM}N/A{RST}')

    if earnings_hist:
        sub(f'Earnings history (last {min(4, len(earnings_hist))} quarters)')
        for eq in earnings_hist[:4]:
            surp = eq.get('surprise')
            surp_s = f'{pct_color(surp)}' if surp is not None else f'{DIM}N/A{RST}'
            actual = f'${eq.get("actual"):.2f}' if eq.get('actual') is not None else 'N/A'
            est    = f'${eq.get("estimate"):.2f}' if eq.get('estimate') is not None else 'N/A'
            print(f'    {eq.get("date","?"):<12} act={actual:<10} est={est:<10} surprise={surp_s}')

    # ── Run model ─────────────────────────────────────────────────────────────
    hdr('5. RUNNING PREDICTION MODEL', '─')
    print(f'  Loading predict_weighted_analysis...')

    # Capture stderr (contains [sanitize], [DEBUG] lines, etc.)
    stderr_capture = io.StringIO()
    result = None
    exc_info = None
    with contextlib.redirect_stderr(stderr_capture):
        try:
            import predict_weighted_analysis as pwa
            print(f'  Running predict({ticker}, ...)...')
            result = pwa.predict(ticker, input_data)
        except Exception:
            exc_info = traceback.format_exc()

    stderr_lines = stderr_capture.getvalue().splitlines()

    if exc_info:
        print(f'{R}Model raised an exception:{RST}')
        print(exc_info)
        sys.exit(1)

    if not result:
        print(f'{R}predict() returned nothing{RST}')
        sys.exit(1)

    print(f'  {G}Model run complete.{RST}')

    # ── Regime info ──────────────────────────────────────────────────────────
    hdr('6. REGIME DETECTION', '─')
    regime = result.get('regime_info', {})
    k = regime.get('k', '?')
    current_r = regime.get('current_regime', '?')
    regime_names = regime.get('regime_names', [])
    probs = regime.get('current_regime_probs', [])

    kv('K (clusters)', k)
    kv('Active regime', f'{current_r} — {regime_names[current_r] if isinstance(current_r, int) and current_r < len(regime_names) else "?"}')
    for i, (name, prob) in enumerate(zip(regime_names, probs)):
        marker = '◀ ACTIVE' if i == current_r else ''
        bar_len = int((prob or 0) * 20)
        bar = '█' * bar_len + '░' * (20 - bar_len)
        col = G if i == current_r else DIM
        print(f'    {col}Regime {i} [{name:<25}] {bar} {prob:.3f} {marker}{RST}')

    # ── Metric analysis ──────────────────────────────────────────────────────
    hdr('7. METRIC ANALYSIS (signal breakdown)', '─')
    m = result.get('metric_analysis', {})
    if m:
        sub('Technical signals')
        kv('RSI signal',       f'{m.get("rsi", {})}')
        kv('Moving averages',  f'{m.get("moving_averages", {})}')
        kv('MACD',             f'{m.get("macd", {})}')
        kv('Growth & trend',   f'{m.get("growth_and_trend", {})}')

        sub('Fundamental signals')
        kv('Sentiment',        f'{m.get("sentiment", {})}')
        kv('Analyst consensus', f'{m.get("analyst_consensus", {})}')
        kv('Earnings beats',   f'{m.get("earnings_beats", {})}')

        sub('Impact summary')
        non_a = m.get('non_analyst_impact', 0.0)
        a_imp = m.get('analyst_impact', 0.0)
        total = m.get('total_metric_impact', 0.0)
        cls   = m.get('impact_classification', '?')

        non_a_col = G if non_a > 0 else (R if non_a < 0 else W)
        a_col     = G if a_imp > 0 else (R if a_imp < 0 else W)
        tot_col   = G if total > 0 else (R if total < 0 else W)

        kv('Non-analyst impact',  f'{non_a_col}{non_a:+.4f}{RST}')
        kv('Analyst impact',      f'{a_col}{a_imp:+.4f}{RST}')
        kv('Total impact',        f'{tot_col}{total:+.4f}{RST}')
        kv('Classification',      cls)
    else:
        print(f'  {DIM}(no metric_analysis in result){RST}')

    # ── Variant adjustments (Fix A/B/C/D) ────────────────────────────────────
    hdr('8. VARIANT ADJUSTMENTS (v5 Fix Stack)', '─')
    va = result.get('variant_adjustments', {})
    if va:
        sub('Input signals used by fixes')
        kv('ret30d',   pct_color(va.get('ret30d')))
        kv('ret90d',   pct_color(va.get('ret90d')))
        kv('beta',     f'{va.get("beta", "N/A")}')
        kv('vix',      f'{va.get("vix", "N/A")}')
        kv('rsi_14d',  f'{va.get("rsi_14d", "N/A")}')

        sub('Fix A — Downtrend trap ceiling (β>0.8, ret30<-5%, ret90<-10%)')
        fix_a_sev = va.get('fixA_severity')
        fix_a_cap = va.get('fixA_cap')
        if fix_a_sev and fix_a_sev > 0:
            kv('Fix A severity',  f'{R}{fix_a_sev:.4f}{RST}  ← FIRED')
            kv('Fix A cap',       f'{R}{fix_a_cap}{RST}')
        else:
            kv('Fix A',  f'{G}not triggered{RST}')

        sub('Fix B — Beta-signed VIX modifier on long_term_multiplier')
        kv('long_term_multiplier', f'{va.get("long_term_multiplier", "N/A")}')

        sub('Fix C — Structural decline (>20% below 52w high, ret90<-15%)')
        fix_c_pct = va.get('fixC_pct_from_52w')
        fix_c_sev = va.get('fixC_severity')
        if fix_c_sev and fix_c_sev > 0:
            kv('Fix C % from 52w high', f'{R}{fix_c_pct:.2f}%{RST}  ← structural decline')
            kv('Fix C severity',        f'{R}{fix_c_sev:.4f}{RST}  ← FIRED')
        else:
            kv('Fix C',  f'{G}not triggered{RST}')
            if fix_c_pct is not None:
                kv('% from 52w high',  f'{fix_c_pct:.2f}%')

        sub('Fix D — Extreme positive momentum (ret90>30%)')
        fix_d = va.get('fixD_xtscale')
        if fix_d and fix_d != 1.0:
            kv('Fix D xtscale',  f'{M}{fix_d:.4f}{RST}  ← applied')
        else:
            kv('Fix D',  f'{G}not triggered{RST}')

        sub('Other adjustments')
        kv('non_analyst_impact',  f'{va.get("non_analyst_impact", "N/A")}')
        kv('analyst_impact',      f'{va.get("analyst_impact", "N/A")}')
    else:
        print(f'  {DIM}(no variant_adjustments in result — may need MODEL_VARIANT=v5){RST}')

    # ── Confidence breakdown ──────────────────────────────────────────────────
    hdr('9. CONFIDENCE BREAKDOWN', '─')
    cb = result.get('confidence_breakdown', {})
    if cb:
        for key, val in cb.items():
            kv(key, f'{val}')
    else:
        print(f'  {DIM}(no confidence_breakdown in result){RST}')

    # ── Data quality ──────────────────────────────────────────────────────────
    hdr('10. DATA QUALITY', '─')
    dq = result.get('data_quality', {})
    if dq:
        for key, val in dq.items():
            kv(key, f'{val}')
    else:
        kv('historyDays', len(hist_rows))
        kv('shortHistory', len(hist_rows) < 200)

    # ── Accuracy metrics ──────────────────────────────────────────────────────
    hdr('11. IN-SAMPLE ACCURACY METRICS', '─')
    am = result.get('accuracy_metrics', {})
    if am:
        for key, val in am.items():
            kv(key, f'{val}')
    else:
        print(f'  {DIM}(no accuracy_metrics in result){RST}')

    # ── Sanitizer stderr output ───────────────────────────────────────────────
    hdr('12. SANITIZER / DEBUG OUTPUT (stderr)', '─')
    sanitize_lines = [l for l in stderr_lines if '[sanitize]' in l.lower()]
    debug_lines    = [l for l in stderr_lines if '[DEBUG]' in l or '[debug]' in l]
    warn_lines     = [l for l in stderr_lines if '[warn]' in l.lower() or 'warning' in l.lower()]
    other_lines    = [l for l in stderr_lines
                      if '[sanitize]' not in l.lower() and '[DEBUG]' not in l
                      and '[debug]' not in l and '[warn]' not in l.lower()
                      and 'warning' not in l.lower()]

    if sanitize_lines:
        sub('Sanitizer clamps')
        for l in sanitize_lines:
            print(f'  {Y}{l}{RST}')
    if debug_lines:
        sub('Debug')
        for l in debug_lines:
            print(f'  {B}{l}{RST}')
    if warn_lines:
        sub('Warnings')
        for l in warn_lines:
            print(f'  {Y}{l}{RST}')
    if other_lines:
        sub('Other stderr')
        for l in other_lines[:30]:
            print(f'  {DIM}{l}{RST}')

    if not stderr_lines:
        print(f'  {DIM}(no stderr output captured){RST}')

    # ── Raw predictions ───────────────────────────────────────────────────────
    hdr('13. RAW PREDICTION OUTPUT', '─')

    def fmt_pred(label: str, price_key: str, pct_key: str, conf_key: str, dir_key: str):
        price_v = result.get(price_key)
        pct_v   = result.get(pct_key)
        conf_v  = result.get(conf_key)
        dir_v   = result.get(dir_key, '?')
        dir_col = G if dir_v == 'up' else (R if dir_v == 'down' else Y)
        p_str   = price_str(price_v, current_price) if price_v is not None else f'{DIM}N/A{RST}'
        pct_str2 = pct_color(pct_v)
        c_str   = conf_color(conf_v)
        print(f'  {BRT}{label:<10}{RST} price={p_str:<35} pct={pct_str2:<20} conf={c_str:<10} dir={dir_col}{dir_v}{RST}')

    fmt_pred('1 week',  'predicted_price_1w', 'predicted_change_pct_1w', 'confidence_score_1w', 'predicted_direction_1w')
    fmt_pred('1 month', 'predicted_price_1m', 'predicted_change_pct_1m', 'confidence_score_1m', 'predicted_direction_1m')
    fmt_pred('6 month', 'predicted_price_6m', 'predicted_change_pct_6m', 'confidence_score_6m', 'predicted_direction_6m')
    fmt_pred('1 year',  'predicted_price_1y', 'predicted_change_pct_1y', 'confidence_score_1y', 'predicted_direction_1y')

    ceiling_6m = result.get('at_model_ceiling_6m')
    ceiling_1y = result.get('at_model_ceiling_1y')
    ceiling_dir = result.get('ceiling_direction')
    if ceiling_6m or ceiling_1y:
        print(f'\n  {Y}⚠ Model ceiling hit: 6m={ceiling_6m}, 1y={ceiling_1y}, direction={ceiling_dir}{RST}')

    # ── Diagnosis summary ─────────────────────────────────────────────────────
    hdr('14. DIAGNOSIS SUMMARY', '─')

    red_flags: list[str] = []
    yellow_flags: list[str] = []
    green_flags: list[str] = []

    # Data quality
    if len(hist_rows) < 200:
        red_flags.append(f'Insufficient history: {len(hist_rows)} days < 200 minimum')
    elif len(hist_rows) < 500:
        yellow_flags.append(f'Short history: {len(hist_rows)} days (ideally 2+ years)')
    else:
        green_flags.append(f'Good history: {len(hist_rows)} days')

    # Sanitizer clamps
    if sanitize_lines:
        for l in sanitize_lines:
            red_flags.append(f'Sanitizer clamped: {l.strip()}')

    # Fix A
    fix_a_sev = va.get('fixA_severity', 0) if va else 0
    if fix_a_sev and fix_a_sev > 0:
        red_flags.append(f'Fix A (downtrend trap) fired with severity={fix_a_sev:.3f}. High-beta + strong recent decline caps upside.')

    # Fix C
    fix_c_sev = va.get('fixC_severity', 0) if va else 0
    fix_c_pct = va.get('fixC_pct_from_52w') if va else None
    if fix_c_sev and fix_c_sev > 0:
        red_flags.append(f'Fix C (structural decline) fired: {fix_c_pct:.1f}% from 52w high, severity={fix_c_sev:.3f}')
    elif fix_c_pct is not None and fix_c_pct < -20:
        yellow_flags.append(f'Near Fix C threshold: {fix_c_pct:.1f}% from 52w high (triggers at <-20% AND ret90d<-15%)')

    # Fix D
    fix_d = va.get('fixD_xtscale', 1.0) if va else 1.0
    if fix_d and fix_d > 1.0:
        yellow_flags.append(f'Fix D (extreme momentum) scaled predictions by {fix_d:.2f}x')

    # Ceiling
    if ceiling_6m or ceiling_1y:
        yellow_flags.append(f'Model ceiling hit (6m={ceiling_6m}, 1y={ceiling_1y}, dir={ceiling_dir}) — upside/downside bounded by vol-scaled cap')

    # Bearish momentum
    if ret_30d is not None and ret_30d < -10:
        red_flags.append(f'Strong 30d decline: {ret_30d:+.1f}%')
    elif ret_30d is not None and ret_30d < -5:
        yellow_flags.append(f'Moderate 30d decline: {ret_30d:+.1f}%')

    if ret_90d is not None and ret_90d < -15:
        red_flags.append(f'Strong 90d decline: {ret_90d:+.1f}% (Fix A/C may activate)')
    elif ret_90d is not None and ret_90d < -10:
        yellow_flags.append(f'Moderate 90d decline: {ret_90d:+.1f}%')

    # RSI extremes
    if rsi_val is not None:
        if rsi_val > 70:
            yellow_flags.append(f'RSI overbought: {rsi_val:.1f} (may dampen confidence)')
        elif rsi_val < 30:
            yellow_flags.append(f'RSI oversold: {rsi_val:.1f}')

    # Analyst coverage
    n_analysts = stock_metrics.get('analystOpinionCount') or 0
    if n_analysts == 0:
        yellow_flags.append('No analyst coverage — consensus signal is 0.0 (neutral)')
    elif n_analysts < 3:
        yellow_flags.append(f'Thin analyst coverage: {n_analysts} analysts (unreliable)')
    else:
        green_flags.append(f'Analyst coverage: {n_analysts} analysts')

    # Upside vs prediction
    analyst_upside = stock_metrics.get('analystUpside')
    pred_1y = result.get('predicted_change_pct_1y')
    if analyst_upside is not None and pred_1y is not None:
        delta = abs(analyst_upside - pred_1y)
        if delta > 30:
            yellow_flags.append(f'Large analyst/model divergence: analysts={analyst_upside:+.1f}% vs model={pred_1y:+.1f}%')

    # Consecutive bearish predictions
    all_neg = all(
        (result.get(f'predicted_change_pct_{h}') or 0) < 0
        for h in ['1w', '1m', '6m', '1y']
    )
    if all_neg:
        red_flags.append('All four horizons are bearish — check for structural decline or data issue')

    # Extreme prediction
    if pred_1y is not None and pred_1y < -50:
        red_flags.append(f'Extreme 1y prediction: {pred_1y:+.1f}% — verify this is model signal, not sanitizer artifact')

    # Beta + VIX
    beta_v = va.get('beta') if va else (stock_metrics.get('beta'))
    vix_v  = va.get('vix') if va else None
    if beta_v is not None and vix_v is not None:
        if beta_v > 1.5 and vix_v > 25:
            yellow_flags.append(f'High-beta ({beta_v:.2f}) in elevated VIX ({vix_v:.1f}) — Fix B dampens long-term upside')

    # Print flags
    if red_flags:
        sub('🔴 Red flags')
        for f in red_flags:
            print(f'  {R}✗ {f}{RST}')

    if yellow_flags:
        sub('🟡 Yellow flags')
        for f in yellow_flags:
            print(f'  {Y}⚠ {f}{RST}')

    if green_flags:
        sub('🟢 Positive signals')
        for f in green_flags:
            print(f'  {G}✓ {f}{RST}')

    if not red_flags and not yellow_flags:
        print(f'\n  {G}No red or yellow flags detected. Prediction appears nominal.{RST}')

    # ── Footer ────────────────────────────────────────────────────────────────
    hdr('END OF DIAGNOSTIC REPORT', '═')
    print(f'  Ticker: {ticker}  |  Price: ${current_price:.4f}  |  History: {len(hist_rows)}d')
    print(f'  Total flags: {R}{len(red_flags)} red{RST}, {Y}{len(yellow_flags)} yellow{RST}, {G}{len(green_flags)} green{RST}')
    print()


if __name__ == '__main__':
    main()
