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
import os
import sys
import argparse
import mysql.connector
from mysql.connector import Error
from datetime import datetime, date, timedelta
import yfinance as yf
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

from predict_weighted_analysis import predict, _sanitize_predictions

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

HORIZONS = [('1w', 7), ('1m', 30), ('6m', 180), ('1y', 365)]

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
_sector_cache = {}


def get_db_connection():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT, autocommit=False,
    )


def get_sector(ticker: str) -> str:
    if ticker in _sector_cache:
        return _sector_cache[ticker]
    sector = '_default'
    try:
        info = yf.Ticker(ticker).info
        sector = info.get('sector') or '_default'
    except Exception as exc:
        print(f"  [warn] Could not fetch sector for {ticker}, using _default: {exc}")
    _sector_cache[ticker] = sector
    return sector


def fetch_history(ticker: str, start: date, end: date) -> list:
    """Full daily OHLCV history (adjusted), ascending, as a list of dicts."""
    df = yf.Ticker(ticker).history(start=start.isoformat(), end=end.isoformat(), auto_adjust=True)
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


def build_input_data(sector: str, hist_trunc: list, macro_full: dict, as_of: str) -> dict:
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
    }

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
        'featureMetrics':     {},
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


def compute_accuracy_metrics(actual_price: float, predicted_price: float, price_at_prediction: float):
    """Mirrors resolve_predictions.compute_accuracy_metrics exactly, so
    backtested and naturally-resolved rows are scored identically."""
    if predicted_price == 0:
        accuracy_pct = 0.0
    else:
        accuracy_pct = max(0, (1 - abs(actual_price - predicted_price) / predicted_price) * 100)

    predicted_direction = 1 if predicted_price > price_at_prediction else (0 if predicted_price < price_at_prediction else -1)
    actual_direction = 1 if actual_price > price_at_prediction else (0 if actual_price < price_at_prediction else -1)

    if predicted_direction == -1 or actual_direction == -1:
        direction_correct = 0
    else:
        direction_correct = 1 if predicted_direction == actual_direction else 0

    return round(accuracy_pct, 2), direction_correct


def upsert_backtest_row(conn, row: dict, overwrite: bool) -> str:
    """Insert a backdated prediction_records row. Returns inserted/updated/skipped/error."""
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT id FROM prediction_records WHERE symbol = %s AND predicted_at = %s",
            (row['symbol'], row['predicted_at']),
        )
        existing = cursor.fetchone()

        if existing and not overwrite:
            return 'skipped'

        columns = [
            'price_at_prediction',
            'predicted_price_1w', 'predicted_price_1m', 'predicted_price_6m', 'predicted_price_1y',
            'actual_price_1w', 'actual_price_1m', 'actual_price_6m', 'actual_price_1y',
            'accuracy_pct_1w', 'accuracy_pct_1m', 'accuracy_pct_6m', 'accuracy_pct_1y',
            'direction_correct_1w', 'direction_correct_1m', 'direction_correct_6m', 'direction_correct_1y',
            'resolved_1w', 'resolved_1m', 'resolved_6m', 'resolved_1y',
        ]
        values = [row[c] for c in columns]

        if existing:
            set_clause = ', '.join(f"{c} = %s" for c in columns)
            cursor.execute(
                f"UPDATE prediction_records SET {set_clause}, updated_at = NOW() WHERE id = %s",
                values + [existing[0]],
            )
            conn.commit()
            return 'updated'
        else:
            insert_cols = ['symbol', 'predicted_at'] + columns
            placeholders = ', '.join(['%s'] * len(insert_cols))
            cursor.execute(
                f"INSERT INTO prediction_records ({', '.join(insert_cols)}) VALUES ({placeholders})",
                [row['symbol'], row['predicted_at']] + values,
            )
            conn.commit()
            return 'inserted'
    except Error as exc:
        conn.rollback()
        print(f"  [db] ERROR upserting {row['symbol']} {row['predicted_at']}: {exc}")
        return 'error'
    finally:
        cursor.close()


def backtest_one(ticker: str, as_of: str, full_hist: list, macro_full: dict, conn, dry_run: bool, overwrite: bool):
    """Returns the computed row dict, or None if this (ticker, as_of) was skipped."""
    as_of_date = datetime.strptime(as_of, '%Y-%m-%d').date()
    hist_trunc = [r for r in full_hist if r['date'] <= as_of]

    if len(hist_trunc) < 365:
        print(f"  [skip] {ticker} {as_of}: only {len(hist_trunc)} days of history before this date (need >= 365)")
        return None

    sector = get_sector(ticker)
    input_data = build_input_data(sector, hist_trunc, macro_full, as_of)

    try:
        result = predict(ticker, input_data)
        result = _sanitize_predictions(result)
    except Exception as exc:
        print(f"  [error] {ticker} {as_of}: prediction failed: {exc}")
        return None

    price_at_prediction = hist_trunc[-1]['close']
    row = {'symbol': ticker, 'predicted_at': as_of, 'price_at_prediction': price_at_prediction}
    summary_bits = [f"{ticker} {as_of} price={price_at_prediction:.2f}"]

    for h, days_offset in HORIZONS:
        predicted_price = result.get(f'predicted_price_{h}')
        row[f'predicted_price_{h}'] = predicted_price

        target_date = as_of_date + timedelta(days=days_offset)
        actual_price = find_actual_price(full_hist, target_date)

        if actual_price is not None and predicted_price is not None:
            accuracy_pct, direction_correct = compute_accuracy_metrics(actual_price, predicted_price, price_at_prediction)
            row[f'actual_price_{h}']       = actual_price
            row[f'accuracy_pct_{h}']       = accuracy_pct
            row[f'direction_correct_{h}']  = direction_correct
            row[f'resolved_{h}']           = 1
            summary_bits.append(f"{h}: pred={predicted_price:.2f} actual={actual_price:.2f} acc={accuracy_pct:.1f}%")
        else:
            row[f'actual_price_{h}']       = None
            row[f'accuracy_pct_{h}']       = None
            row[f'direction_correct_{h}']  = None
            row[f'resolved_{h}']           = 0
            pred_str = f"{predicted_price:.2f}" if predicted_price is not None else "n/a"
            summary_bits.append(f"{h}: pred={pred_str} (not yet resolvable)")

    print("  " + " | ".join(summary_bits))

    if dry_run:
        print(f"  [dry-run] would upsert prediction_records row for {ticker} {as_of}")
        return row

    status = upsert_backtest_row(conn, row, overwrite)
    if status == 'skipped':
        print(f"  [skip] {ticker} {as_of}: already backtested (use --overwrite to replace)")
        return None
    print(f"  [db] {status} {ticker} {as_of}")
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
        avg_dir = sum(r[f'direction_correct_{h}'] for r in resolved) / len(resolved) * 100
        print(f"  {h}: {len(resolved)}/{len(results)} resolved | avg accuracy {avg_acc:.1f}% | direction correct {avg_dir:.1f}%")


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
                row = backtest_one(ticker, as_of, full_hist, ticker_macro, conn, args.dry_run, args.overwrite)
                if row is not None:
                    all_results.append(row)
    finally:
        if conn is not None:
            conn.close()

    print_summary(all_results)
    print(f"\n[{datetime.now().isoformat()}] Backtest complete.")


if __name__ == '__main__':
    main()
