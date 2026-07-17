"""
backfill_stock_search.py — Populate stocks.sector / industry / size_bucket /
search_tsv from Yahoo Finance so /api/search can serve category queries
("Large Retail", "banks", "chip") in addition to ticker/name lookups.

Runs the 001 migration first (idempotent), then walks the `stocks` table:
  1. Reuses scripts/prediction_cache/sector_map.json when present.
  2. Fetches assetProfile from Yahoo for each ticker missing sector or
     industry (yfinance .info covers both fields in one call).
  3. Computes size_bucket from stocks.market_cap.
  4. Builds a synonym-expanded search_tsv used by the FULLTEXT index.

Usage:
  python3 scripts/backfill_stock_search.py                  # only rows missing data
  python3 scripts/backfill_stock_search.py --refresh        # refetch every ticker
  python3 scripts/backfill_stock_search.py --tickers WMT,AAPL
  python3 scripts/backfill_stock_search.py --sleep 0.6      # rate-limit Yahoo
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import mysql.connector
import yfinance as yf
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
SECTOR_CACHE = SCRIPT_DIR / 'prediction_cache' / 'sector_map.json'
INDUSTRY_CACHE = SCRIPT_DIR / 'prediction_cache' / 'industry_map.json'
INDUSTRY_CACHE.parent.mkdir(exist_ok=True)

if (PROJECT_ROOT / '.env.production').exists():
    load_dotenv(PROJECT_ROOT / '.env.production')
load_dotenv(PROJECT_ROOT / '.env.local', override=True)


# ── Size bucket thresholds (USD market cap) ──────────────────────────────────
# Standard US-market convention. Each bucket carries both the enum value (used
# for filtering) and the search tokens sprinkled into search_tsv. The token
# list is intentionally colloquial — a user typing "Large Retail" expects
# WMT ($500B, technically mega-cap), so "mega" also carries "large" and "big".
SIZE_THRESHOLDS = [
    (200_000_000_000, 'mega',  ['mega-cap', 'mega', 'large-cap', 'large', 'big', 'major', 'giant']),
    (10_000_000_000,  'large', ['large-cap', 'large', 'big']),
    (2_000_000_000,   'mid',   ['mid-cap', 'mid', 'medium']),
    (300_000_000,     'small', ['small-cap', 'small']),
    (50_000_000,      'micro', ['micro-cap', 'micro', 'tiny']),
    (0,               'nano',  ['nano-cap', 'nano', 'tiny']),
]


def size_bucket_for(market_cap):
    """Return (enum_bucket, [search_tokens])."""
    if market_cap is None or market_cap <= 0:
        return None, []
    for threshold, bucket, tokens in SIZE_THRESHOLDS:
        if market_cap >= threshold:
            return bucket, tokens
    return None, []


# ── Industry → synonym map ───────────────────────────────────────────────────
# FULLTEXT tokenizes on whitespace, so a query for "Retail" must find the
# literal word "retail" in the row. Yahoo's industry values ("Discount Stores",
# "Auto Parts", "Semiconductor Equipment & Materials") often don't include the
# colloquial term the user typed. We inject the extra tokens here.
#
# The map is keyword→synonyms: if the industry string contains the keyword
# (case-insensitive), the synonyms are appended to search_tsv.
INDUSTRY_SYNONYMS = {
    'store':                    ['retail', 'shopping', 'stores'],
    'retail':                   ['retail', 'shopping', 'stores'],
    'apparel':                  ['clothing', 'fashion', 'retail'],
    'restaurant':               ['restaurants', 'food service', 'dining'],
    'grocery':                  ['grocery', 'supermarket', 'food', 'retail'],
    'bank':                     ['bank', 'banking', 'finance', 'financial'],
    'insurance':                ['insurance', 'insurers'],
    'capital markets':          ['broker', 'brokerage', 'trading', 'finance'],
    'asset management':         ['asset manager', 'wealth', 'finance'],
    'credit services':          ['lending', 'credit', 'finance'],
    'reit':                     ['real estate', 'reit', 'property'],
    'real estate':              ['real estate', 'reit', 'property'],
    'semiconductor':            ['chip', 'chips', 'semiconductor', 'semiconductors'],
    'software':                 ['software', 'saas', 'tech', 'technology'],
    'internet':                 ['internet', 'web', 'tech'],
    'communication':            ['telecom', 'communications'],
    'telecom':                  ['telecom', 'communications'],
    'media':                    ['media', 'entertainment'],
    'entertainment':            ['media', 'entertainment', 'streaming'],
    'biotech':                  ['biotech', 'biotechnology', 'pharma', 'healthcare'],
    'drug':                     ['pharma', 'pharmaceutical', 'drugs', 'healthcare'],
    'pharmaceutical':           ['pharma', 'pharmaceutical', 'drugs', 'healthcare'],
    'medical':                  ['medical', 'healthcare', 'medtech'],
    'healthcare':               ['healthcare', 'medical'],
    'oil':                      ['oil', 'petroleum', 'energy'],
    'gas':                      ['gas', 'energy', 'natural gas'],
    'coal':                     ['coal', 'energy', 'mining'],
    'mining':                   ['mining', 'metals', 'materials'],
    'gold':                     ['gold', 'mining', 'precious metals'],
    'silver':                   ['silver', 'mining', 'precious metals'],
    'copper':                   ['copper', 'mining', 'metals'],
    'aerospace':                ['aerospace', 'defense'],
    'defense':                  ['defense', 'defence', 'military', 'aerospace'],
    'airline':                  ['airline', 'airlines', 'aviation', 'travel'],
    'auto':                     ['auto', 'automotive', 'car', 'cars', 'vehicle'],
    'utilities':                ['utility', 'utilities'],
    'utility':                  ['utility', 'utilities'],
    'solar':                    ['solar', 'clean energy', 'renewable'],
    'renewable':                ['renewable', 'clean energy'],
    'shipping':                 ['shipping', 'logistics', 'freight'],
    'railroad':                 ['rail', 'railroad', 'transportation'],
    'agricultural':             ['agriculture', 'farming', 'agri'],
    'farm':                     ['agriculture', 'farming', 'agri'],
    'construction':             ['construction', 'building'],
    'homebuilding':             ['homebuilder', 'housing', 'construction'],
    'chemicals':                ['chemical', 'chemicals', 'materials'],
    'steel':                    ['steel', 'metals', 'materials'],
    'packaging':                ['packaging', 'materials'],
    'tobacco':                  ['tobacco'],
    'beverages':                ['beverage', 'beverages', 'drinks'],
    'household':                ['consumer goods', 'household'],
    'personal products':        ['consumer goods', 'personal care'],
    'leisure':                  ['leisure', 'entertainment', 'travel'],
    'gambling':                 ['gambling', 'gaming', 'casino'],
    'lodging':                  ['hotel', 'hotels', 'lodging', 'travel'],
    'hotel':                    ['hotel', 'hotels', 'lodging', 'travel'],
    'travel':                   ['travel', 'tourism'],
}


def synonyms_for_industry(industry: str) -> list[str]:
    if not industry:
        return []
    lower = industry.lower()
    out: list[str] = []
    for keyword, syns in INDUSTRY_SYNONYMS.items():
        if keyword in lower:
            out.extend(syns)
    # de-dupe while preserving order
    seen, unique = set(), []
    for s in out:
        if s not in seen:
            seen.add(s)
            unique.append(s)
    return unique


def build_search_tsv(symbol, company_name, sector, industry, size_tokens):
    parts = [
        symbol or '',
        company_name or '',
        sector or '',
        industry or '',
    ]
    parts.extend(size_tokens)
    parts.extend(synonyms_for_industry(industry or ''))
    text = ' '.join(p for p in parts if p).strip()
    # Lowercase — FULLTEXT is case-insensitive but keeping it lowercase makes
    # eyeballing rows easier and avoids duplicate tokens differing only in case.
    return text.lower()


# ── DB + cache helpers ───────────────────────────────────────────────────────

def db():
    return mysql.connector.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD'),
        database=os.getenv('DB_DATABASE'),
        port=int(os.getenv('DB_PORT', 3306)),
    )


def load_json(path: Path) -> dict:
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_json(path: Path, data: dict) -> None:
    with open(path, 'w') as f:
        json.dump(data, f, indent=2, sort_keys=True)


def fetch_yahoo(ticker: str) -> tuple[str | None, str | None]:
    """Return (sector, industry) from yfinance .info; None on any failure."""
    try:
        info = yf.Ticker(ticker).info or {}
        return info.get('sector'), info.get('industry')
    except Exception as exc:
        print(f"    [yahoo-fail] {ticker}: {exc}", file=sys.stderr)
        return None, None


# ── Main ─────────────────────────────────────────────────────────────────────

def apply_migrations():
    """Run the SQL migration runner in the same working process."""
    runner = SCRIPT_DIR / 'migrations' / 'run_migrations.py'
    if not runner.exists():
        print(f"[migrate] runner not found at {runner}, skipping", file=sys.stderr)
        return
    subprocess.run([sys.executable, str(runner)], check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tickers', help='Comma-separated list, e.g. WMT,AAPL')
    parser.add_argument('--refresh', action='store_true',
                        help='Refetch Yahoo even if row already has sector/industry')
    parser.add_argument('--sleep', type=float, default=0.4,
                        help='Seconds between Yahoo calls (default 0.4)')
    parser.add_argument('--skip-migrate', action='store_true',
                        help='Skip the migration step (assume already applied)')
    args = parser.parse_args()

    if not args.skip_migrate:
        apply_migrations()

    sector_cache = load_json(SECTOR_CACHE)
    industry_cache = load_json(INDUSTRY_CACHE)

    conn = db()
    cur = conn.cursor(dictionary=True)

    if args.tickers:
        wanted = [t.strip().upper() for t in args.tickers.split(',') if t.strip()]
        placeholders = ','.join(['%s'] * len(wanted))
        cur.execute(
            f"SELECT id, symbol, company_name, market_cap, sector, industry "
            f"FROM stocks WHERE symbol IN ({placeholders})",
            wanted,
        )
    else:
        cur.execute(
            "SELECT id, symbol, company_name, market_cap, sector, industry FROM stocks"
        )
    rows = cur.fetchall()
    print(f"[backfill] {len(rows)} stocks in scope", file=sys.stderr)

    update_cur = conn.cursor()
    updates = 0
    yahoo_hits = 0

    for i, row in enumerate(rows, 1):
        symbol = row['symbol']
        if not symbol:
            continue

        sector = row['sector']
        industry = row['industry']

        # Prefer cached lookups; fall back to Yahoo only when needed.
        need_lookup = args.refresh or not sector or not industry
        if need_lookup:
            cached_sector = sector_cache.get(symbol)
            cached_industry = industry_cache.get(symbol)
            if cached_sector and not args.refresh:
                sector = sector or cached_sector
            if cached_industry and not args.refresh:
                industry = industry or cached_industry

        if args.refresh or not sector or not industry:
            y_sector, y_industry = fetch_yahoo(symbol)
            yahoo_hits += 1
            if y_sector:
                sector = y_sector
                sector_cache[symbol] = y_sector
            if y_industry:
                industry = y_industry
                industry_cache[symbol] = y_industry
            time.sleep(args.sleep)

        bucket, size_tokens = size_bucket_for(row['market_cap'])
        search_tsv = build_search_tsv(
            symbol, row['company_name'], sector, industry, size_tokens
        )

        update_cur.execute(
            """
            UPDATE stocks
               SET sector = %s,
                   industry = %s,
                   size_bucket = %s,
                   search_tsv = %s
             WHERE id = %s
            """,
            (sector, industry, bucket, search_tsv, row['id']),
        )
        updates += 1

        if i % 50 == 0:
            conn.commit()
            save_json(SECTOR_CACHE, sector_cache)
            save_json(INDUSTRY_CACHE, industry_cache)
            print(
                f"  [{i:>4}/{len(rows)}] committed (yahoo hits so far: {yahoo_hits})",
                file=sys.stderr,
            )

    conn.commit()
    save_json(SECTOR_CACHE, sector_cache)
    save_json(INDUSTRY_CACHE, industry_cache)
    update_cur.close()
    cur.close()
    conn.close()
    print(
        f"[backfill] done — {updates} rows updated, {yahoo_hits} Yahoo lookups",
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
