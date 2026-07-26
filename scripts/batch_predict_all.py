#!/usr/bin/env python3
"""
batch_predict_all.py — Run predictions for every ticker in the stocks table.

Fetches Yahoo Finance data per ticker, POSTs to the warm prediction service
(port 7861), and writes results to a CSV. Does NOT write to the database.

Usage:
    python3 scripts/batch_predict_all.py
    python3 scripts/batch_predict_all.py --output ~/predictions_$(date +%Y%m%d).csv
    python3 scripts/batch_predict_all.py --limit 10          # dry run on first 10
    python3 scripts/batch_predict_all.py --resume output.csv # skip already-done rows
    python3 scripts/batch_predict_all.py --delay 0.3         # faster (risk: rate-limit)

The script saves a checkpoint every 50 tickers so a crash midway doesn't lose
all work — just re-run with --resume <same file>.

Estimated runtime: ~2-4 hours for 1,740 tickers at the default 0.5 s delay
(Yahoo data fetch + prediction service call per ticker).
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import mysql.connector
import requests
import yfinance as yf
from dotenv import load_dotenv

# ── Env ───────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
load_dotenv(PROJECT_ROOT / '.env.production', override=False)
load_dotenv(PROJECT_ROOT / '.env.local',      override=True)

DB_CONFIG = {
    'host':     os.getenv('DB_HOST',     'localhost'),
    'user':     os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_DATABASE'),
    'port':     int(os.getenv('DB_PORT', '3306')),
}

PREDICTION_SERVICE_URL = os.getenv('PREDICTION_SERVICE_URL', 'http://127.0.0.1:7861')
MIN_HISTORY_ROWS       = 200
CHECKPOINT_EVERY       = 50   # flush CSV every N tickers

# ── CSV schema ────────────────────────────────────────────────────────────────
CSV_FIELDS = [
    'ticker', 'company_name', 'sector', 'current_price', 'gps_score_db',
    # fundamental / analyst
    'revenue_growth_yoy', 'earnings_growth_yoy', 'technical_signal',
    'analyst_target_upside_pct', 'analyst_consensus', '52w_momentum_pct',
    'analyst_grade', 'analyst_grade_composite',
    # 1-week
    'predicted_price_1w', 'predicted_change_pct_1w', 'confidence_score_1w',
    # 1-month
    'predicted_price_1m', 'predicted_change_pct_1m', 'confidence_score_1m',
    # 6-month
    'predicted_price_6m', 'predicted_change_pct_6m', 'confidence_score_6m',
    # 1-year
    'predicted_price_1y', 'predicted_change_pct_1y', 'confidence_score_1y',
    # meta
    'model_version', 'error',
]


# ── DB helpers ────────────────────────────────────────────────────────────────
def get_tickers_and_gps() -> list[dict]:
    """Return all stocks with their existing GPS scores (NULL if none)."""
    conn   = mysql.connector.connect(**DB_CONFIG)
    cursor = conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT s.symbol, s.company_name, s.sector,
               sgs.gps_score
        FROM   stocks s
        LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
        ORDER  BY s.symbol
    """)
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return rows


# ── Yahoo Finance fetcher ─────────────────────────────────────────────────────
def fetch_yahoo_data(ticker: str) -> tuple[Optional[list], Optional[dict], Optional[str], Optional[object]]:
    """
    Returns (historical_data, stock_metrics, error_str, yf_ticker).
    On failure, historical_data and stock_metrics are None and error_str is set.
    yf_ticker is returned so callers can call .recommendations_summary etc.
    """
    try:
        t    = yf.Ticker(ticker)
        hist = t.history(period='2y', auto_adjust=False)
    except Exception as e:
        return None, None, f'yf.history failed: {e}', None

    if hist.empty or len(hist) < MIN_HISTORY_ROWS:
        return None, None, f'insufficient_history ({len(hist)} rows)', None

    historical_data = []
    for row in hist.itertuples():
        close = row.Close
        if close != close:  # NaN check
            continue
        historical_data.append({
            'date':   str(row.Index.date()),
            'open':   float(row.Open)   if row.Open   == row.Open   else float(close),
            'high':   float(row.High)   if row.High   == row.High   else float(close),
            'low':    float(row.Low)    if row.Low    == row.Low    else float(close),
            'close':  float(close),
            'volume': float(row.Volume) if row.Volume == row.Volume else 0.0,
        })

    if len(historical_data) < MIN_HISTORY_ROWS:
        return None, None, f'insufficient_clean_rows ({len(historical_data)})', None

    current_price = historical_data[-1]['close']

    # Fetch richer metrics — analyst data, PE, beta, etc.
    stock_metrics: dict = {'regularMarketPrice': current_price}
    try:
        info = t.info or {}
        analyst_target = info.get('targetMeanPrice')
        analyst_upside = (
            (analyst_target - current_price) / current_price * 100
            if analyst_target and current_price else None
        )
        stock_metrics.update({
            'regularMarketPrice':       current_price,
            'beta':                     info.get('beta'),
            'trailingPE':               info.get('trailingPE'),
            'forwardPE':                info.get('forwardPE'),
            'priceToBook':              info.get('priceToBook'),
            'marketCap':                info.get('marketCap'),
            'revenueGrowth':            info.get('revenueGrowth'),
            'earningsGrowth':           info.get('earningsGrowth'),
            'grossMargins':             info.get('grossMargins'),
            'recommendationKey':        info.get('recommendationKey'),
            'recommendationMean':       info.get('recommendationMean'),
            'numberOfAnalystOpinions':  info.get('numberOfAnalystOpinions'),
            'fiftyTwoWeekChange':       info.get('52WeekChange'),
            'analystUpside':            analyst_upside,
            'targetMeanPrice':          analyst_target,
            'fiftyDayAverage':          info.get('fiftyDayAverage'),
            'twoHundredDayAverage':     info.get('twoHundredDayAverage'),
            'targetLowPrice':           info.get('targetLowPrice'),
            'targetHighPrice':          info.get('targetHighPrice'),
        })
    except Exception:
        # info call failed — prediction will still run with price + history only
        pass

    return historical_data, stock_metrics, None, t


# ── Technical signal ─────────────────────────────────────────────────────────
def compute_technical_signal(stock_metrics: dict) -> str:
    """
    MA crossover signal: price vs 50-day vs 200-day moving averages.
      Bullish  — price > 50d MA and 50d MA > 200d MA (golden cross regime)
      Bearish  — price < 50d MA and 50d MA < 200d MA (death cross regime)
      Neutral  — mixed (price between MAs, or MA data unavailable)
    """
    price  = stock_metrics.get('regularMarketPrice')
    ma50   = stock_metrics.get('fiftyDayAverage')
    ma200  = stock_metrics.get('twoHundredDayAverage')
    if not (price and ma50 and ma200):
        return ''
    if price > ma50 and ma50 > ma200:
        return 'Bullish'
    if price < ma50 and ma50 < ma200:
        return 'Bearish'
    return 'Neutral'


# ── Analyst grade (A+ → F-) ───────────────────────────────────────────────────
_PERIOD_WEIGHTS = {'0m': 0.40, '-1m': 0.25, '-2m': 0.20, '-3m': 0.15}

def _grade_from_composite(score: float) -> str:
    if score >= 93: return 'A+'
    if score >= 87: return 'A'
    if score >= 82: return 'A-'
    if score >= 77: return 'B+'
    if score >= 72: return 'B'
    if score >= 67: return 'B-'
    if score >= 62: return 'C+'
    if score >= 57: return 'C'
    if score >= 52: return 'C-'
    if score >= 47: return 'D+'
    if score >= 42: return 'D'
    if score >= 37: return 'D-'
    if score >= 27: return 'F+'
    if score >= 14: return 'F'
    return 'F-'

def compute_analyst_grade(ticker_obj, stock_metrics: dict) -> tuple[str, str]:
    """
    Returns (grade_letter, composite_score_str).
    Mirrors the TypeScript computeAnalystGrade in src/utils/analystGrade.ts.
    """
    try:
        rec_summary = ticker_obj.recommendations_summary
        if rec_summary is None or rec_summary.empty:
            return '', ''

        # Build period → WRS map
        wrs_map: dict[str, float] = {}
        for _, row in rec_summary.iterrows():
            period = str(row.get('period', '')).strip()
            if period not in _PERIOD_WEIGHTS:
                continue
            total = sum(row.get(c, 0) or 0 for c in ('strongBuy','buy','hold','sell','strongSell'))
            if total <= 0:
                continue
            wrs = (5*(row.get('strongBuy',0) or 0) + 4*(row.get('buy',0) or 0) +
                   3*(row.get('hold',0) or 0)       + 2*(row.get('sell',0) or 0) +
                   1*(row.get('strongSell',0) or 0)) / total
            wrs_map[period] = wrs

        if '0m' not in wrs_map:
            return '', ''

        # Step 1 — blended WRS
        blended, weight_sum = 0.0, 0.0
        for period, w in _PERIOD_WEIGHTS.items():
            if period in wrs_map:
                blended   += w * wrs_map[period]
                weight_sum += w
        if weight_sum <= 0:
            return '', ''
        blended /= weight_sum

        # Step 2 — RecScore (WRS 1–5 → 0–100)
        rec_score = ((blended - 1) / 4) * 100

        # Step 3 — MomentumScore
        wrs0    = wrs_map['0m']
        wrs_old = wrs_map.get('-3m') or wrs_map.get('-2m') or wrs_map.get('-1m') or wrs0
        momentum_score = max(0.0, min(100.0, 50 + (wrs0 - wrs_old) * 50))

        # Step 4 — UpsideScore
        upside_score = 50.0
        target_mean = stock_metrics.get('targetMeanPrice')
        price       = stock_metrics.get('regularMarketPrice')
        if target_mean and price and price > 0:
            upside_pct  = (target_mean - price) / price * 100
            upside_score = max(0.0, min(100.0, (upside_pct + 20) / 60 * 100))

        # Step 5 — ConvictionScore (tight target spread = high conviction)
        conviction_score = 50.0
        t_low  = stock_metrics.get('targetLowPrice')
        t_high = stock_metrics.get('targetHighPrice')
        if t_low and t_high and target_mean and target_mean > 0:
            dispersion = (t_high - t_low) / target_mean
            conviction_score = max(0.0, min(100.0, 100 - dispersion * 100))

        # Step 6 — CoverageScore: more analysts = more reliable signal (sqrt scale, caps at 30)
        import math
        row_0m = rec_summary[rec_summary['period'] == '0m']
        if not row_0m.empty:
            r = row_0m.iloc[0]
            total_0m = sum(r.get(c, 0) or 0 for c in ('strongBuy','buy','hold','sell','strongSell'))
        else:
            total_0m = 0
        coverage_score = min(100.0, (math.sqrt(total_0m) / math.sqrt(30)) * 100)

        composite = max(0.0, min(100.0,
            0.47 * rec_score + 0.29 * upside_score +
            0.14 * momentum_score + 0.05 * conviction_score + 0.05 * coverage_score))
        composite = round(composite * 10) / 10

        return _grade_from_composite(composite), f"{composite:.1f}"
    except Exception:
        return '', ''


# ── Prediction service caller ─────────────────────────────────────────────────
def call_predict(ticker: str, historical_data: list, stock_metrics: dict) -> dict:
    payload = {
        'ticker':     ticker,
        'input_data': {
            'historicalData':     historical_data,
            'stockMetrics':       stock_metrics,
            'macroData':          {},
            'optionsData':        {},
            'featureMetrics':     {},
            'newsArticles':       [],
            'historicalEarnings': [],
        },
        'outlook': 'all',
    }
    resp = requests.post(
        f'{PREDICTION_SERVICE_URL}/predict',
        json=payload,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


# ── CSV writer ────────────────────────────────────────────────────────────────
def write_csv(path: Path, rows: list[dict], append: bool = False) -> None:
    mode = 'a' if append else 'w'
    with open(path, mode, newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction='ignore')
        if not append:
            writer.writeheader()
        writer.writerows(rows)


def load_done_tickers(path: Path) -> set[str]:
    """Read tickers already present in an existing CSV (for --resume)."""
    done: set[str] = set()
    if not path.exists():
        return done
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if row.get('ticker'):
                done.add(row['ticker'])
    return done


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(
        description='Batch predict all stocks → CSV (no DB writes)'
    )
    parser.add_argument(
        '--output', '-o',
        default=str(PROJECT_ROOT / f"predictions_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"),
        help='Output CSV path',
    )
    parser.add_argument(
        '--delay', type=float, default=0.5,
        help='Seconds between tickers (default 0.5, lower risks Yahoo rate-limit)',
    )
    parser.add_argument(
        '--limit', type=int, default=0,
        help='Process only the first N tickers (0 = all). Useful for dry runs.',
    )
    parser.add_argument(
        '--resume', action='store_true',
        help='Skip tickers already present in --output file and append new rows.',
    )
    args = parser.parse_args()

    output_path = Path(args.output)

    # Verify prediction service is up before burning time on data fetches
    print(f"[batch_predict] Checking prediction service at {PREDICTION_SERVICE_URL}...")
    try:
        r = requests.get(f'{PREDICTION_SERVICE_URL}/health', timeout=6)
        r.raise_for_status()
        print(f"[batch_predict] Service healthy ✓")
    except Exception as e:
        print(f"\n[batch_predict] ERROR: prediction service not reachable: {e}", file=sys.stderr)
        print(f"[batch_predict] Make sure it is running:  pm2 status", file=sys.stderr)
        sys.exit(1)

    print(f"[batch_predict] Loading ticker list from DB...")
    all_rows = get_tickers_and_gps()

    # --resume: skip already-completed tickers
    done_tickers: set[str] = set()
    append_mode = False
    if args.resume:
        done_tickers = load_done_tickers(output_path)
        append_mode  = bool(done_tickers)
        if done_tickers:
            print(f"[batch_predict] Resuming — skipping {len(done_tickers)} already-done tickers")

    rows_to_run = [r for r in all_rows if r['symbol'] not in done_tickers]
    if args.limit:
        rows_to_run = rows_to_run[:args.limit]

    total     = len(rows_to_run)
    errors    = 0
    buffer:   list[dict] = []
    start_ts  = time.time()

    print(f"[batch_predict] {total} tickers to process → {output_path}")
    print(f"[batch_predict] Estimated time at {args.delay}s delay: "
          f"~{timedelta(seconds=int(total * (3 + args.delay)))}\n")

    # If not resuming, create fresh file with header now
    if not append_mode:
        write_csv(output_path, [], append=False)

    for i, row in enumerate(rows_to_run, 1):
        ticker       = row['symbol']
        company_name = row.get('company_name') or ''
        sector       = row.get('sector') or ''
        gps_score_db = row.get('gps_score')

        # ETA
        elapsed  = time.time() - start_ts
        rate     = i / elapsed if elapsed > 0 else 1
        eta_secs = int((total - i) / rate) if rate > 0 else 0
        eta_str  = str(timedelta(seconds=eta_secs))

        print(f"[{i:4d}/{total}] {ticker:<8} | ETA {eta_str}", end='  ', flush=True)

        rec: dict = {
            'ticker':                   ticker,
            'company_name':             company_name,
            'sector':                   sector,
            'gps_score_db':             f"{gps_score_db:.1f}" if gps_score_db is not None else '',
            'current_price':            '',
            'revenue_growth_yoy':       '',
            'earnings_growth_yoy':      '',
            'technical_signal':         '',
            'analyst_target_upside_pct': '',
            'analyst_consensus':        '',
            '52w_momentum_pct':         '',
            'analyst_grade':            '',
            'analyst_grade_composite':  '',
            'model_version':            '',
            'error':                    '',
        }
        # Pre-fill prediction columns as empty
        for h in ('1w', '1m', '6m', '1y'):
            rec[f'predicted_price_{h}']      = ''
            rec[f'predicted_change_pct_{h}'] = ''
            rec[f'confidence_score_{h}']     = ''

        try:
            historical_data, stock_metrics, err, yf_ticker = fetch_yahoo_data(ticker)
            if err:
                raise ValueError(err)

            rec['current_price'] = round(stock_metrics.get('regularMarketPrice') or 0, 4)

            def _pct(v: Optional[float]) -> str:
                return f"{v * 100:.2f}" if v is not None else ''

            rev_growth = stock_metrics.get('revenueGrowth')
            earn_growth = stock_metrics.get('earningsGrowth')
            upside = stock_metrics.get('analystUpside')
            momentum = stock_metrics.get('fiftyTwoWeekChange')

            rec['revenue_growth_yoy']        = _pct(rev_growth)
            rec['earnings_growth_yoy']       = _pct(earn_growth)
            rec['technical_signal']          = compute_technical_signal(stock_metrics)
            rec['analyst_target_upside_pct'] = f"{upside:.2f}" if upside is not None else ''
            rec['analyst_consensus']         = stock_metrics.get('recommendationKey') or ''
            rec['52w_momentum_pct']          = _pct(momentum)

            grade, composite = compute_analyst_grade(yf_ticker, stock_metrics)
            rec['analyst_grade']           = grade
            rec['analyst_grade_composite'] = composite

            result = call_predict(ticker, historical_data, stock_metrics)

            for h in ('1w', '1m', '6m', '1y'):
                rec[f'predicted_price_{h}']      = result.get(f'predicted_price_{h}',      '')
                rec[f'predicted_change_pct_{h}'] = result.get(f'predicted_change_pct_{h}', '')
                rec[f'confidence_score_{h}']     = result.get(f'confidence_score_{h}',     '')

            rec['model_version'] = result.get('model_version', '')

            pct_6m = result.get('predicted_change_pct_6m', '')
            pct_str = f"{pct_6m:+.2f}%" if isinstance(pct_6m, (int, float)) else str(pct_6m)
            print(f"✓  6m={pct_str}")

        except Exception as e:
            rec['error'] = str(e)[:250]
            errors += 1
            print(f"✗  {rec['error'][:70]}")

        buffer.append(rec)

        # Checkpoint flush every N rows
        if len(buffer) >= CHECKPOINT_EVERY:
            write_csv(output_path, buffer, append=True)
            buffer = []

        if i < total:
            time.sleep(args.delay)

    # Final flush
    if buffer:
        write_csv(output_path, buffer, append=True)

    elapsed_total = timedelta(seconds=int(time.time() - start_ts))
    successful    = total - errors
    print(f"\n{'─'*60}")
    print(f"[batch_predict] Complete in {elapsed_total}")
    print(f"[batch_predict] {successful:,} succeeded  |  {errors:,} errors  |  {total:,} total")
    print(f"[batch_predict] CSV → {output_path.resolve()}")


if __name__ == '__main__':
    main()
