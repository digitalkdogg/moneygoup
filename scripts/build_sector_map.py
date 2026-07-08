"""
build_sector_map.py — Populate scripts/prediction_cache/sector_map.json
from Yahoo's assetProfile.sector for each ticker in the local universe.

Consumed by compute_sector_medians.py and build_ranking_dataset.py. Cheap
to re-run (idempotent — merges into existing file).

Usage:
  python3 scripts/build_sector_map.py                # all yahoo_historical_fundamentals tickers
  python3 scripts/build_sector_map.py AAPL MSFT ...  # explicit list
  python3 scripts/build_sector_map.py --from-stocks  # all rows from `stocks` table
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import mysql.connector
import yfinance as yf
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
CACHE_PATH = SCRIPT_DIR / 'prediction_cache' / 'sector_map.json'
CACHE_PATH.parent.mkdir(exist_ok=True)

if (PROJECT_ROOT / '.env.production').exists():
    load_dotenv(PROJECT_ROOT / '.env.production')
load_dotenv(PROJECT_ROOT / '.env.local', override=True)


def db():
    return mysql.connector.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD'),
        database=os.getenv('DB_DATABASE'),
        port=int(os.getenv('DB_PORT', 3306)),
    )


def load_existing() -> dict:
    if CACHE_PATH.exists():
        try:
            with open(CACHE_PATH) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('tickers', nargs='*', help='Explicit ticker list')
    parser.add_argument('--from-stocks', action='store_true', help='Pull tickers from `stocks` table')
    parser.add_argument('--refresh',     action='store_true', help='Refetch even tickers already cached')
    parser.add_argument('--sleep',       type=float, default=0.4, help='Sleep between requests (default 0.4s)')
    args = parser.parse_args()

    if args.tickers:
        tickers = [t.upper().strip() for t in args.tickers]
    else:
        conn = db()
        cur  = conn.cursor()
        if args.from_stocks:
            cur.execute("SELECT symbol FROM stocks WHERE symbol IS NOT NULL")
        else:
            cur.execute("SELECT DISTINCT symbol FROM yahoo_historical_fundamentals")
        tickers = [r[0] for r in cur.fetchall()]
        cur.close(); conn.close()

    existing = load_existing()
    if not args.refresh:
        remaining = [t for t in tickers if t not in existing]
    else:
        remaining = tickers

    print(f"[sector-map] {len(tickers)} target(s); {len(existing)} cached; fetching {len(remaining)} new", file=sys.stderr)

    resolved = 0
    for i, t in enumerate(remaining, 1):
        try:
            info = yf.Ticker(t).info
            sector = info.get('sector')
            if sector:
                existing[t] = sector
                resolved += 1
        except Exception as exc:
            print(f"  [{i:>4}/{len(remaining)}] {t}: {exc}", file=sys.stderr)
        # Cheap incremental write every 25 tickers — safe if the process dies mid-run.
        if i % 25 == 0:
            with open(CACHE_PATH, 'w') as f:
                json.dump(existing, f, indent=2, sort_keys=True)
            print(f"  [{i:>4}/{len(remaining)}] checkpoint (total cached: {len(existing)})", file=sys.stderr)
        time.sleep(args.sleep)

    with open(CACHE_PATH, 'w') as f:
        json.dump(existing, f, indent=2, sort_keys=True)
    sectors = sorted(set(existing.values()))
    print(f"[sector-map] wrote {len(existing)} entries across {len(sectors)} sectors → {CACHE_PATH}", file=sys.stderr)


if __name__ == '__main__':
    main()
