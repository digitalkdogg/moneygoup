#!/usr/bin/env python3
"""
diagnose_deepmoney_env.py — Read-only environment diagnostic for the
DeepMoney sync pipeline, the user dashboard, and the /search page.

Run this on both Bluehost (production) and local dev, then diff the two
`--json` outputs (or just eyeball the printed reports) to see where the
two environments have actually diverged — schema drift, config drift
(DEEPMONEY_ALGORITHM level), and data freshness.

This script makes NO writes. It only reads from the database directly
(same connection path as deepmoney_sync.py) and optionally makes one or
two cheap, unauthenticated HTTP calls to endpoints that accept the
internal `x-api-key` bypass. It never calls the DeepMoney discovery API
itself, since that can trigger a 10-20+ minute re-run — the algorithm
preset that run would resolve to is computed locally instead, from the
same env var + models/algorithm_presets.json that route.ts reads.

Usage:
  python3 scripts/diagnose_deepmoney_env.py
  python3 scripts/diagnose_deepmoney_env.py --label bluehost --json > bluehost_diag.json
  python3 scripts/diagnose_deepmoney_env.py --skip-http
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

import mysql.connector
import requests
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent

# ── Env loading — same precedence as deepmoney_sync.py ────────────────────
_loaded_env_files: list[str] = []
for _f in ('.env.production', '.env.local', '.env'):
    _p = PROJECT_ROOT / _f
    if _p.exists():
        load_dotenv(_p, override=(_f != '.env.production'))
        _loaded_env_files.append(_f)

INTERNAL_API_URL = 'http://localhost:3001'
CONFIDENCE_BUCKETS = (35, 50, 65, 75)


def _mask(value: str | None, keep: int = 4) -> str:
    if not value:
        return '(unset)'
    if len(value) <= keep:
        return '*' * len(value)
    return value[:keep] + '*' * (len(value) - keep)


def _fmt_age(dt: datetime | None) -> str:
    if dt is None:
        return 'never'
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - dt
    hours = delta.total_seconds() / 3600
    if hours < 1:
        return f"{delta.total_seconds() / 60:.0f}m ago"
    if hours < 48:
        return f"{hours:.1f}h ago"
    return f"{hours / 24:.1f}d ago"


# ── Section 1: host + env vars ─────────────────────────────────────────────

ENV_VARS_OF_INTEREST = [
    'DEEPMONEY_ALGORITHM',
    'DEEPMONEY_INTERNAL_SECRET',
    'NEXTAUTH_URL',
    'OLLAMA_ENABLED',
    'OLLAMA_BASE_URL',
    'USE_LEGACY_PREDICTION_MODEL',
    'CS_MODEL_VERSION',
    'DB_HOST',
    'DB_DATABASE',
    'DB_PORT',
    'DATABASE_URL',
    'GPS_DEEPMONEY_MIN_SCORE',
    'GPS_BASELINE',
    'GPS_SELL_OFFSET',
    'GPS_DISCOVERY_OFFSET',
    'DASHBOARD_TENURE_ROTATION',
    'DASHBOARD_TENURE_MAX_DAYS',
    'DASHBOARD_TENURE_COOLDOWN_DAYS',
    'DASHBOARD_TENURE_TARGET_CARDS',
    'DASHBOARD_TENURE_MIN_CARDS',
    'ETF_HOLDING_ALGORITHM',
]

# Values that are secrets — mask before printing/serializing.
_SECRET_VARS = {'DEEPMONEY_INTERNAL_SECRET', 'DATABASE_URL', 'DB_PASSWORD'}


def collect_host_info(label: str | None) -> dict:
    return {
        'label': label or platform.node(),
        'hostname': platform.node(),
        'platform': platform.platform(),
        'python_version': platform.python_version(),
        'cwd': str(Path.cwd()),
        'env_files_loaded': _loaded_env_files,
        'checked_at': datetime.now(timezone.utc).isoformat(),
    }


def collect_env_vars() -> dict:
    out = {}
    for name in ENV_VARS_OF_INTEREST:
        raw = os.getenv(name)
        out[name] = _mask(raw) if name in _SECRET_VARS else (raw if raw is not None else '(unset)')
    return out


# ── Section 2: algorithm preset resolution (local, no network) ────────────

def load_algorithm_presets() -> dict:
    path = PROJECT_ROOT / 'models' / 'algorithm_presets.json'
    with open(path) as fh:
        return json.load(fh)


def _snap_to_bucket_ceiling(value: float) -> float:
    for bucket in CONFIDENCE_BUCKETS:
        if value <= bucket:
            return bucket
    return CONFIDENCE_BUCKETS[-1]


def resolve_algorithm_preset() -> dict:
    """Mirrors src/utils/algorithmPreset.ts resolveAlgorithm() exactly, so
    this environment's effective preset can be compared to another
    environment's without ever calling the (expensive) discovery API."""
    raw = os.getenv('DEEPMONEY_ALGORITHM')
    try:
        level = float(raw) if raw else 5.0
        if level < 1 or level > 10:
            level = 5.0
    except (TypeError, ValueError):
        level = 5.0

    table = load_algorithm_presets()
    lo = int(level)
    hi = min(lo + 1, 10)
    t = level - lo
    lo_p, hi_p = table[str(max(lo, 1))], table[str(hi)]

    def lerp(a, b):
        return a + (b - a) * t

    resolved = {
        'level': level,
        'rankerKeepPct': round(lerp(lo_p['rankerKeepPct'], hi_p['rankerKeepPct']), 4),
        'mlpConfidenceFloor': _snap_to_bucket_ceiling(lerp(lo_p['mlpConfidenceFloor'], hi_p['mlpConfidenceFloor'])),
        'volGateFloor': _snap_to_bucket_ceiling(lerp(lo_p['volGateFloor'], hi_p['volGateFloor'])),
        'signalScoreFloor': round(lerp(lo_p['signalScoreFloor'], hi_p['signalScoreFloor']), 2),
    }
    return resolved


# ── Section 3: database ────────────────────────────────────────────────────

def resolve_db_connection_params() -> dict:
    """Mirrors src/utils/db.ts buildPoolConfig(): DATABASE_URL wins over
    the discrete DB_* vars when both are set, so the diagnostic must
    connect the same way the Node app actually does."""
    database_url = os.getenv('DATABASE_URL')
    if database_url:
        from urllib.parse import urlparse, unquote
        parsed = urlparse(database_url)
        return {
            'mode': 'DATABASE_URL',
            'host': parsed.hostname,
            'port': parsed.port or 3306,
            'user': unquote(parsed.username or ''),
            'password': unquote(parsed.password or ''),
            'database': (parsed.path or '/').lstrip('/') or None,
        }
    return {
        'mode': 'discrete DB_* vars',
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', 3306)),
        'user': os.getenv('DB_USER'),
        'password': os.getenv('DB_PASSWORD'),
        'database': os.getenv('DB_DATABASE'),
    }


def connect_db(params: dict):
    return mysql.connector.connect(
        host=params['host'], port=params['port'],
        user=params['user'], password=params['password'],
        database=params['database'],
    )


def column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """SELECT 1 FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s""",
        (table, column),
    )
    return cur.fetchone() is not None


def table_exists(cur, table: str) -> bool:
    cur.execute(
        """SELECT 1 FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s""",
        (table,),
    )
    return cur.fetchone() is not None


SCHEMA_COLUMN_CHECKS = [
    # (table, column) — code assumes these exist; missing = silent drift.
    ('stocks', 'is_etf'),               # route.ts fetchDbSectorLeaderTickers — errors silently if missing
    ('stocks', 'search_tsv'),           # /api/search FULLTEXT + backfill_stock_search.py
    ('stocks', 'size_bucket'),          # /api/search result shaping
    ('stocks', 'sector'),
    ('stocks', 'industry'),
    ('recommended_stocks', 'gps_score_type'),  # deepmoney_sync.py idempotent ALTER (ranker path)
    ('recommended_stocks', 'ranker_score'),
    ('recommended_stocks', 'hist_vol_30'),
    ('stock_gps_scores', 'gps_score_type'),
    ('stock_gps_scores', 'ranker_score'),
    ('stock_gps_scores', 'hist_vol_30'),
]

SCHEMA_TABLE_CHECKS = [
    'dashboard_tenure', 'hot_etfs', 'prediction_records',
    'macro_context_snapshots', 'user_stock_predictions', 'user_stocks',
    'stock_gps_scores', 'recommended_stocks', 'stocks',
]


def run_schema_checks(cur) -> dict:
    tables = {t: table_exists(cur, t) for t in SCHEMA_TABLE_CHECKS}
    columns = {}
    for table, col in SCHEMA_COLUMN_CHECKS:
        if not tables.get(table, False):
            columns[f'{table}.{col}'] = None  # table itself missing
            continue
        columns[f'{table}.{col}'] = column_exists(cur, table, col)
    return {'tables': tables, 'columns': columns}


def run_fulltext_probe(cur, search_term: str) -> dict:
    """Actually run the /api/search FULLTEXT query rather than just check
    for an index by name (the repo's migrations for it are missing on
    disk, so there's no fixed index name to look up — see backfill_stock_search.py
    and the referenced-but-absent 001_stocks_search_columns.sql)."""
    try:
        cur.execute(
            """SELECT symbol, MATCH(symbol, company_name, sector, industry, search_tsv)
                        AGAINST (%s IN BOOLEAN MODE) AS relevance
                 FROM stocks
                WHERE MATCH(symbol, company_name, sector, industry, search_tsv)
                        AGAINST (%s IN BOOLEAN MODE)
                ORDER BY relevance DESC LIMIT 5""",
            (search_term, search_term),
        )
        rows = cur.fetchall()
        return {'ok': True, 'sample_term': search_term, 'match_count': len(rows),
                'sample_symbols': [r[0] for r in rows]}
    except mysql.connector.Error as exc:
        return {'ok': False, 'sample_term': search_term, 'error_code': exc.errno, 'error': str(exc)}


def run_freshness_checks(cur) -> dict:
    out: dict = {}

    def scalar(query, params=()):
        cur.execute(query, params)
        row = cur.fetchone()
        return row[0] if row else None

    if column_exists(cur, 'recommended_stocks', 'snapshot_date'):
        latest_snapshot = scalar("SELECT MAX(snapshot_date) FROM recommended_stocks")
        out['recommended_stocks_latest_snapshot'] = str(latest_snapshot) if latest_snapshot else None
        if latest_snapshot:
            out['recommended_stocks_hot_stocks_count'] = scalar(
                "SELECT COUNT(*) FROM recommended_stocks WHERE snapshot_date = %s AND type = 'hot_stocks'",
                (latest_snapshot,))
            out['recommended_stocks_etf_holding_count'] = scalar(
                "SELECT COUNT(*) FROM recommended_stocks WHERE snapshot_date = %s AND type = 'etf_holding'",
                (latest_snapshot,))

    if table_exists(cur, 'stock_gps_scores'):
        latest_gps = scalar("SELECT MAX(as_of) FROM stock_gps_scores")
        out['stock_gps_scores_latest_as_of'] = str(latest_gps) if latest_gps else None
        out['stock_gps_scores_age'] = _fmt_age(latest_gps) if latest_gps else 'never'

    if table_exists(cur, 'hot_etfs'):
        if column_exists(cur, 'hot_etfs', 'snapshot_date'):
            latest_etf = scalar("SELECT MAX(snapshot_date) FROM hot_etfs")
            out['hot_etfs_latest_snapshot'] = str(latest_etf) if latest_etf else None
            out['hot_etfs_count_latest'] = scalar(
                "SELECT COUNT(*) FROM hot_etfs WHERE snapshot_date = %s", (latest_etf,)) if latest_etf else 0

    out['stocks_total'] = scalar("SELECT COUNT(*) FROM stocks")
    if column_exists(cur, 'stocks', 'search_tsv'):
        out['stocks_with_search_tsv'] = scalar(
            "SELECT COUNT(*) FROM stocks WHERE search_tsv IS NOT NULL AND search_tsv <> ''")

    if table_exists(cur, 'dashboard_tenure'):
        out['dashboard_tenure_total'] = scalar("SELECT COUNT(*) FROM dashboard_tenure")
        out['dashboard_tenure_active'] = scalar(
            "SELECT COUNT(*) FROM dashboard_tenure WHERE evicted_at IS NULL")

    if table_exists(cur, 'prediction_records'):
        for col in ('predicted_at', 'created_at'):
            if column_exists(cur, 'prediction_records', col):
                latest_pred = scalar(f"SELECT MAX({col}) FROM prediction_records")
                out['prediction_records_latest'] = str(latest_pred) if latest_pred else None
                out['prediction_records_age'] = _fmt_age(latest_pred) if latest_pred else 'never'
                break

    return out


def run_dashboard_reconstruction(cur) -> dict:
    """Reconstructs what /api/dashboard/deepmoney-picks would currently
    render, straight from the DB, using the same gate the route applies
    (type='hot_stocks' AND gps_score >= GPS_DEEPMONEY_MIN_SCORE for the
    latest snapshot_date). Skipped gracefully if the schema doesn't support it.
    """
    if not column_exists(cur, 'recommended_stocks', 'snapshot_date'):
        return {'skipped': 'recommended_stocks.snapshot_date missing'}

    threshold_raw = os.getenv('GPS_DEEPMONEY_MIN_SCORE')
    try:
        threshold = float(threshold_raw) if threshold_raw else 65.0
    except ValueError:
        threshold = 65.0

    cur.execute("SELECT MAX(snapshot_date) FROM recommended_stocks")
    latest = cur.fetchone()[0]
    if not latest:
        return {'gps_threshold': threshold, 'would_render_count': 0, 'sample': []}

    cur.execute(
        """SELECT ticker, gps_score FROM recommended_stocks
            WHERE snapshot_date = %s AND type = 'hot_stocks' AND gps_score >= %s
            ORDER BY gps_score DESC LIMIT 15""",
        (latest, threshold),
    )
    rows = cur.fetchall()
    cur.execute(
        """SELECT COUNT(*) FROM recommended_stocks
            WHERE snapshot_date = %s AND type = 'hot_stocks' AND gps_score >= %s""",
        (latest, threshold),
    )
    total = cur.fetchone()[0]

    return {
        'snapshot_date': str(latest),
        'gps_threshold': threshold,
        'would_render_count': total,
        'sample': [{'ticker': r[0], 'gps_score': float(r[1])} for r in rows],
    }


# ── Section 4: live HTTP probes (optional, unauthenticated bypass only) ───

def run_http_probes(skip: bool) -> dict:
    if skip:
        return {'skipped': '--skip-http passed'}

    secret = (os.getenv('DEEPMONEY_INTERNAL_SECRET') or '').strip('"')
    if not secret:
        return {'skipped': 'DEEPMONEY_INTERNAL_SECRET not set'}

    out = {}
    headers = {'x-api-key': secret}

    # /api/market/trending accepts the internal-key bypass and is cheap
    # (reads cached scores, doesn't trigger discovery) — safe live check
    # of "what would /search's trending grid show right now."
    try:
        resp = requests.get(
            f"{INTERNAL_API_URL}/api/market/trending", params={'window': '48h', 'limit': 12},
            headers=headers, timeout=15,
        )
        body = {}
        try:
            body = resp.json()
        except ValueError:
            pass
        items = body.get('tickers') or body.get('trending') or body.get('data') or []
        out['market_trending'] = {
            'status': resp.status_code,
            'item_count': len(items) if isinstance(items, list) else None,
            'ok': resp.status_code == 200,
        }
    except requests.RequestException as exc:
        out['market_trending'] = {'ok': False, 'error': str(exc)}

    return out


# ── Report rendering ───────────────────────────────────────────────────────

def _fmt_bool(v) -> str:
    if v is None:
        return 'N/A (table missing)'
    return 'YES' if v else 'MISSING'


def render_report(data: dict) -> str:
    lines = []
    w = lines.append
    host = data['host']
    w('=' * 74)
    w(f"  DEEPMONEY ENVIRONMENT DIAGNOSTIC — {host['label']}")
    w('=' * 74)
    w(f"  Hostname:      {host['hostname']}")
    w(f"  Platform:      {host['platform']}")
    w(f"  Env files:     {', '.join(host['env_files_loaded']) or '(none found)'}")
    w(f"  Checked at:    {host['checked_at']}")

    w('')
    w('  DB CONNECTION  (mirrors src/utils/db.ts precedence: DATABASE_URL wins over discrete DB_* vars)')
    dbc = data['db_connection']
    w(f"    mode={dbc['mode']}  host={dbc['host']}  port={dbc['port']}  database={dbc['database']}")

    w('')
    w('  ENV VARS')
    for k, v in data['env_vars'].items():
        w(f"    {k:<32} {v}")

    w('')
    w('  RESOLVED ALGORITHM PRESET  (computed locally from DEEPMONEY_ALGORITHM + models/algorithm_presets.json)')
    ap = data['algorithm_preset']
    w(f"    level={ap['level']:g}  rankerKeepPct={ap['rankerKeepPct']:.4f}  "
      f"mlpConfidenceFloor={ap['mlpConfidenceFloor']:g}  volGateFloor={ap['volGateFloor']:g}  "
      f"signalScoreFloor={ap['signalScoreFloor']:g}")

    w('')
    w('  SCHEMA DRIFT CHECKS')
    w('    Tables:')
    for t, exists in data['schema']['tables'].items():
        w(f"      {t:<28} {_fmt_bool(exists)}")
    w('    Columns:')
    for c, exists in data['schema']['columns'].items():
        w(f"      {c:<38} {_fmt_bool(exists)}")

    w('')
    w('  FULLTEXT SEARCH LIVE PROBE  (actual /api/search MATCH...AGAINST query)')
    ft = data['fulltext_probe']
    if ft['ok']:
        w(f"    OK — term={ft['sample_term']!r} matched {ft['match_count']} row(s): {ft['sample_symbols']}")
    else:
        w(f"    FAILED — term={ft['sample_term']!r} errno={ft.get('error_code')}: {ft.get('error')}")

    w('')
    w('  DATA FRESHNESS')
    for k, v in data['freshness'].items():
        w(f"    {k:<40} {v}")

    w('')
    w('  DASHBOARD RECONSTRUCTION  (what /api/dashboard/deepmoney-picks would render now)')
    dash = data['dashboard']
    if 'skipped' in dash:
        w(f"    SKIPPED — {dash['skipped']}")
    else:
        w(f"    snapshot_date={dash.get('snapshot_date')}  gps_threshold={dash.get('gps_threshold')}"
          f"  would_render_count={dash.get('would_render_count')}")
        for row in dash.get('sample', [])[:15]:
            w(f"      {row['ticker']:<10} GPS {row['gps_score']:.1f}")

    w('')
    w('  LIVE HTTP PROBES')
    http = data['http_probes']
    if http.get('skipped'):
        w(f"    SKIPPED — {http['skipped']}")
    else:
        for name, res in http.items():
            if res.get('ok'):
                w(f"    {name:<20} OK  status={res.get('status')}  item_count={res.get('item_count')}")
            else:
                w(f"    {name:<20} FAIL  {res.get('error') or res}")

    w('=' * 74)
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--label', help='Environment label for the report header (default: hostname)')
    parser.add_argument('--json', action='store_true', help='Emit machine-readable JSON instead of the text report')
    parser.add_argument('--output', help='Write the report to this file (in addition to stdout)')
    parser.add_argument('--skip-http', action='store_true', help='Skip live HTTP probes (DB-only diagnostic)')
    parser.add_argument('--search-term', default='technology', help='Term to use for the live FULLTEXT search probe')
    args = parser.parse_args()

    data: dict = {
        'host': collect_host_info(args.label),
        'env_vars': collect_env_vars(),
    }

    try:
        data['algorithm_preset'] = resolve_algorithm_preset()
    except Exception as exc:
        data['algorithm_preset'] = {'error': str(exc)}

    db_params = resolve_db_connection_params()
    data['db_connection'] = {
        'mode': db_params['mode'],
        'host': db_params['host'],
        'port': db_params['port'],
        'database': db_params['database'],
    }

    try:
        conn = connect_db(db_params)
        cur = conn.cursor()
        data['schema'] = run_schema_checks(cur)
        data['fulltext_probe'] = run_fulltext_probe(cur, args.search_term)
        data['freshness'] = run_freshness_checks(cur)
        data['dashboard'] = run_dashboard_reconstruction(cur)
        cur.close()
        conn.close()
    except mysql.connector.Error as exc:
        data['db_error'] = str(exc)
        data.setdefault('schema', {'tables': {}, 'columns': {}})
        data.setdefault('fulltext_probe', {'ok': False, 'sample_term': args.search_term, 'error': 'DB unreachable'})
        data.setdefault('freshness', {})
        data.setdefault('dashboard', {'skipped': 'DB unreachable'})

    data['http_probes'] = run_http_probes(args.skip_http)

    output = json.dumps(data, indent=2, default=str) if args.json else render_report(data)

    print(output)
    if args.output:
        Path(args.output).write_text(output + '\n')

    # Nonzero exit on anything that should page someone: DB unreachable,
    # a schema column silently missing, or the fulltext probe erroring.
    problems = []
    if 'db_error' in data:
        problems.append('db_unreachable')
    for col, exists in data.get('schema', {}).get('columns', {}).items():
        if exists is False:
            problems.append(f'missing_column:{col}')
    if not data.get('fulltext_probe', {}).get('ok', True):
        problems.append('fulltext_probe_failed')

    if problems:
        print(f"\n[diagnose] {len(problems)} issue(s) found: {', '.join(problems)}", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':
    main()