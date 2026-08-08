"""
scripts/fred_macro_sync.py — Fetch key FRED economic series and upsert into
fred_macro_indicators. Designed to run daily or weekly via cron.

Requires:
    FRED_API_KEY env var (free at fred.stlouisfed.org/docs/api/api_key.html)

Usage:
    python3 scripts/fred_macro_sync.py
    python3 scripts/fred_macro_sync.py --dry-run   # print values, skip DB write
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, date
from typing import Optional

import mysql.connector
import requests
from dotenv import load_dotenv

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

for env_file in ('.env.production', '.env.local', '.env'):
    p = os.path.join(PROJECT_ROOT, env_file)
    if os.path.exists(p):
        load_dotenv(p)

DB_HOST      = os.getenv('DB_HOST', 'localhost')
DB_USER      = os.getenv('DB_USER')
DB_PASSWORD  = os.getenv('DB_PASSWORD')
DB_DATABASE  = os.getenv('DB_DATABASE')
FRED_API_KEY = os.getenv('FRED_API_KEY', '')
FRED_BASE    = 'https://api.stlouisfed.org/fred/series/observations'
FETCH_TIMEOUT = 10

# ── Series definitions ────────────────────────────────────────────────────────
# display_mode: mom_abs | yoy_pct | qoq_pct | level
# direction:    higher_good | lower_good | neutral
SERIES_CONFIG = [
    dict(id='PAYEMS',   name='Nonfarm Payrolls',     category='labor',     unit='K jobs',
         freq='monthly',   display='mom_abs', direction='higher_good', fetch_n=15),
    dict(id='UNRATE',   name='Unemployment Rate',    category='labor',     unit='%',
         freq='monthly',   display='mom_abs', direction='lower_good',  fetch_n=15),
    dict(id='CIVPART',  name='Labor Force Participation', category='labor', unit='%',
         freq='monthly',   display='mom_abs', direction='higher_good', fetch_n=15),
    dict(id='CPIAUCSL', name='CPI (All Items)',       category='inflation', unit='index',
         freq='monthly',   display='yoy_pct', direction='lower_good',  fetch_n=15),
    dict(id='CPILFESL', name='Core CPI',              category='inflation', unit='index',
         freq='monthly',   display='yoy_pct', direction='lower_good',  fetch_n=15),
    dict(id='FEDFUNDS', name='Fed Funds Rate',        category='monetary',  unit='%',
         freq='monthly',   display='mom_abs', direction='neutral',     fetch_n=15),
    dict(id='GDP',      name='GDP',                   category='growth',    unit='B USD',
         freq='quarterly', display='qoq_pct', direction='higher_good', fetch_n=6),
    dict(id='T10Y2Y',   name='Yield Curve (10Y-2Y)', category='credit',    unit='%',
         freq='daily',     display='level',   direction='higher_good', fetch_n=5),
    dict(id='UMCSENT',  name='Consumer Sentiment',    category='sentiment', unit='index',
         freq='monthly',   display='mom_abs', direction='higher_good', fetch_n=15),
]

# ── DB helpers ────────────────────────────────────────────────────────────────

def get_db():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD, database=DB_DATABASE,
    )


def ensure_table(cursor):
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS fred_macro_indicators (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            series_id    VARCHAR(50)   NOT NULL,
            series_name  VARCHAR(255)  NOT NULL,
            category     VARCHAR(50)   NOT NULL,
            unit         VARCHAR(50),
            frequency    VARCHAR(20),
            display_mode VARCHAR(20)   COMMENT 'mom_abs|yoy_pct|qoq_pct|level',
            direction    VARCHAR(20)   COMMENT 'higher_good|lower_good|neutral',
            obs_date     DATE          NOT NULL,
            obs_value    DECIMAL(18,4),
            prior_date   DATE,
            prior_value  DECIMAL(18,4),
            yoy_date     DATE,
            yoy_value    DECIMAL(18,4),
            mom_change   DECIMAL(18,4) COMMENT 'obs_value - prior_value',
            yoy_pct      DECIMAL(10,4) COMMENT '% change year-over-year',
            qoq_pct      DECIMAL(10,4) COMMENT '% change quarter-over-quarter',
            synced_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_series (series_id),
            INDEX idx_category (category)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)


def upsert_indicator(cursor, row: dict):
    cursor.execute("""
        INSERT INTO fred_macro_indicators
            (series_id, series_name, category, unit, frequency, display_mode, direction,
             obs_date, obs_value, prior_date, prior_value,
             yoy_date, yoy_value, mom_change, yoy_pct, qoq_pct, synced_at)
        VALUES
            (%(series_id)s, %(series_name)s, %(category)s, %(unit)s, %(frequency)s,
             %(display_mode)s, %(direction)s,
             %(obs_date)s, %(obs_value)s, %(prior_date)s, %(prior_value)s,
             %(yoy_date)s, %(yoy_value)s, %(mom_change)s, %(yoy_pct)s, %(qoq_pct)s,
             %(synced_at)s)
        ON DUPLICATE KEY UPDATE
            series_name  = VALUES(series_name),
            obs_date     = VALUES(obs_date),
            obs_value    = VALUES(obs_value),
            prior_date   = VALUES(prior_date),
            prior_value  = VALUES(prior_value),
            yoy_date     = VALUES(yoy_date),
            yoy_value    = VALUES(yoy_value),
            mom_change   = VALUES(mom_change),
            yoy_pct      = VALUES(yoy_pct),
            qoq_pct      = VALUES(qoq_pct),
            synced_at    = VALUES(synced_at)
    """, row)

# ── FRED fetch ────────────────────────────────────────────────────────────────

def fetch_observations(series_id: str, limit: int) -> list[dict]:
    """Returns a list of {date, value} dicts sorted newest-first, skipping '.' values."""
    params = {
        'series_id':  series_id,
        'api_key':    FRED_API_KEY,
        'sort_order': 'desc',
        'limit':      limit,
        'file_type':  'json',
    }
    try:
        r = requests.get(FRED_BASE, params=params, timeout=FETCH_TIMEOUT)
        r.raise_for_status()
        raw = r.json().get('observations', [])
        return [o for o in raw if o.get('value', '.') != '.']
    except Exception as exc:
        print(f"  [FRED error] {series_id}: {exc}")
        return []


def _val(obs: dict) -> Optional[float]:
    try:
        return float(obs['value'])
    except (ValueError, KeyError):
        return None

# ── Per-series computation ────────────────────────────────────────────────────

def compute_row(cfg: dict) -> Optional[dict]:
    obs = fetch_observations(cfg['id'], cfg['fetch_n'])
    if len(obs) < 1:
        return None

    latest = obs[0]
    obs_value = _val(latest)
    if obs_value is None:
        return None

    prior     = obs[1] if len(obs) > 1 else None
    prior_value = _val(prior) if prior else None
    mom_change  = (obs_value - prior_value) if prior_value is not None else None

    # YoY: find the observation closest to 12 months ago (monthly series only)
    yoy_obs = None
    yoy_value = None
    yoy_pct   = None
    if cfg['freq'] == 'monthly' and len(obs) >= 13:
        # obs is newest-first, so index 12 is ~12 months ago
        yoy_obs   = obs[12]
        yoy_value = _val(yoy_obs)
        if yoy_value and yoy_value != 0:
            yoy_pct = (obs_value - yoy_value) / abs(yoy_value) * 100

    # QoQ % for quarterly series (GDP)
    qoq_pct = None
    if cfg['freq'] == 'quarterly' and prior_value and prior_value != 0:
        qoq_pct = (obs_value - prior_value) / abs(prior_value) * 100

    return {
        'series_id':   cfg['id'],
        'series_name': cfg['name'],
        'category':    cfg['category'],
        'unit':        cfg['unit'],
        'frequency':   cfg['freq'],
        'display_mode':cfg['display'],
        'direction':   cfg['direction'],
        'obs_date':    latest['date'],
        'obs_value':   obs_value,
        'prior_date':  prior['date'] if prior else None,
        'prior_value': prior_value,
        'yoy_date':    yoy_obs['date'] if yoy_obs else None,
        'yoy_value':   yoy_value,
        'mom_change':  mom_change,
        'yoy_pct':     yoy_pct,
        'qoq_pct':     qoq_pct,
        'synced_at':   datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S'),
    }

# ── Formatting helpers for dry-run output ─────────────────────────────────────

def _fmt(cfg: dict, row: dict) -> str:
    mode = cfg['display']
    v    = row['obs_value']
    chg  = None
    chg_str = ''

    if mode == 'mom_abs' and row['mom_change'] is not None:
        chg = row['mom_change']
        chg_str = f"  MoM: {'+' if chg >= 0 else ''}{chg:.1f}"
    elif mode == 'yoy_pct' and row['yoy_pct'] is not None:
        chg = row['yoy_pct']
        chg_str = f"  YoY: {'+' if chg >= 0 else ''}{chg:.2f}%"
    elif mode == 'qoq_pct' and row['qoq_pct'] is not None:
        chg = row['qoq_pct']
        chg_str = f"  QoQ: {'+' if chg >= 0 else ''}{chg:.2f}%"

    dir_map = {'higher_good': chg and chg >= 0, 'lower_good': chg and chg <= 0, 'neutral': None}
    good = dir_map.get(cfg['direction'])
    signal = '🟢' if good else ('🔴' if good is False else '⚪')

    prior_str = f"  Prior: {row['prior_value']}" if row['prior_value'] is not None else ''
    return f"  {cfg['name']:<26} {v:>10.2f} {cfg['unit']:<10}{prior_str}{chg_str}  {signal}"

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='Sync FRED macro indicators to DB')
    ap.add_argument('--dry-run', action='store_true', help='Print values without writing to DB')
    args = ap.parse_args()

    if not FRED_API_KEY:
        print("ERROR: FRED_API_KEY is not set.")
        print("Get a free key at: https://fred.stlouisfed.org/docs/api/api_key.html")
        print("Then add to your .env.local:  FRED_API_KEY=your_key_here")
        sys.exit(1)

    db     = None if args.dry_run else get_db()
    cursor = None if args.dry_run else db.cursor()

    if cursor:
        ensure_table(cursor)
        db.commit()

    ok = skipped = 0
    last_category = None

    for cfg in SERIES_CONFIG:
        if cfg['category'] != last_category:
            print(f"\n{cfg['category'].upper()}")
            last_category = cfg['category']

        row = compute_row(cfg)
        if row is None:
            print(f"  {cfg['name']:<26} — no data")
            skipped += 1
            continue

        print(_fmt(cfg, row))

        if cursor:
            upsert_indicator(cursor, row)
            db.commit()

        ok += 1
        time.sleep(0.1)  # be polite to FRED

    print(f"\n{'─'*50}")
    print(f"Done. {ok} synced  |  {skipped} skipped")

    if db:
        db.close()


if __name__ == '__main__':
    main()
