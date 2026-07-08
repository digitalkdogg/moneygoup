"""
trends_helper.py — Google Trends momentum feature via pytrends.

Emits one metric per ticker: SearchInterest_20d_Change =
  mean(last 5 days of search interest) / mean(20-25 days ago) - 1

Aggressively cached to `scripts/.trends_cache/{TICKER}.json` with a 30-day
freshness window — Google throttles hard, so we prefer stale data over 429s.
Cache values are the full daily time series returned by pytrends' interest_over_time,
so we can also service backtest queries at earlier as-of dates without re-hitting
the API.

CLI usage (called by the Next.js route via child_process.spawn):
  python3 trends_helper.py <TICKER> [--as-of YYYY-MM-DD]
Prints a JSON dict {"searchInterest_20d_change": float | null} on stdout.

Errors are always suppressed to a null result — Trends is a nice-to-have,
not a must-have, and Google's API is unreliable enough that we shouldn't
break /data over it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

CACHE_DIR = Path(__file__).parent / '.trends_cache'
CACHE_DIR.mkdir(exist_ok=True)
CACHE_TTL_DAYS = 30


def _cache_path(ticker: str) -> Path:
    return CACHE_DIR / f'{ticker.upper()}.json'


def _load_cache(ticker: str) -> dict | None:
    p = _cache_path(ticker)
    if not p.exists():
        return None
    try:
        with open(p) as f:
            payload = json.load(f)
        fetched = datetime.fromisoformat(payload.get('fetched_at', '2000-01-01'))
        if (datetime.now() - fetched).days > CACHE_TTL_DAYS:
            return None
        return payload
    except Exception:
        return None


def _save_cache(ticker: str, series: dict) -> None:
    try:
        with open(_cache_path(ticker), 'w') as f:
            json.dump(series, f)
    except Exception:
        pass


def _fetch_trends(ticker: str) -> dict | None:
    """Fetch 5 years of daily interest via pytrends. Returns a dict of
    {'fetched_at': iso, 'series': {'YYYY-MM-DD': float, ...}} or None on failure."""
    try:
        from pytrends.request import TrendReq
    except ImportError:
        return None

    try:
        pytrends = TrendReq(hl='en-US', tz=0, retries=1, backoff_factor=0.3)
        pytrends.build_payload([ticker], timeframe='today 5-y', geo='US')
        df = pytrends.interest_over_time()
        if df is None or df.empty:
            return None
        series = {str(idx.date()): float(row[ticker]) for idx, row in df.iterrows() if ticker in row}
        if not series:
            return None
        # Rate-limit friendly — small delay to be a good citizen.
        time.sleep(0.5)
        return {'fetched_at': datetime.now().isoformat(), 'series': series}
    except Exception:
        return None


def compute_change(series: dict, as_of: str | None) -> float | None:
    """Compute mean(last 5d) / mean(20-25d ago) − 1 as of the given date
    (or today if None). Returns None if either window has fewer than 3 points."""
    if not series:
        return None
    as_of_date = datetime.strptime(as_of, '%Y-%m-%d').date() if as_of else datetime.now().date()
    dates_sorted = sorted(series.keys())
    # Filter to points <= as_of_date
    filtered = [d for d in dates_sorted if d <= str(as_of_date)]
    if len(filtered) < 25:
        return None
    recent = [series[d] for d in filtered[-5:]]
    prior  = [series[d] for d in filtered[-25:-20]]
    if len(recent) < 3 or len(prior) < 3:
        return None
    mean_recent = sum(recent) / len(recent)
    mean_prior  = sum(prior)  / len(prior)
    if mean_prior <= 0:
        return None
    return mean_recent / mean_prior - 1.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('ticker')
    parser.add_argument('--as-of', default=None,
                        help='Compute the change as-of this date (YYYY-MM-DD). Default: today.')
    args = parser.parse_args()

    ticker = args.ticker.upper()

    # Cache read first.
    cached = _load_cache(ticker)
    if cached and cached.get('series'):
        val = compute_change(cached['series'], args.as_of)
        print(json.dumps({'searchInterest_20d_change': val}))
        return

    # Cache miss or expired — fetch fresh.
    fresh = _fetch_trends(ticker)
    if fresh:
        _save_cache(ticker, fresh)
        val = compute_change(fresh['series'], args.as_of)
        print(json.dumps({'searchInterest_20d_change': val}))
        return

    # All paths failed — emit null so the caller treats it as missing.
    print(json.dumps({'searchInterest_20d_change': None}))


if __name__ == '__main__':
    main()
