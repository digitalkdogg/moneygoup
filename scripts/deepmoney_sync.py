import json
import os
import sys
import time
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv
from prediction_recorder import record_prediction
from fred_macro_sync import SERIES_CONFIG, compute_row, ensure_table, upsert_indicator
# Reuse the exact size-bucket + search_tsv logic the backfill uses so a stock
# discovered by DeepMoney is indexed identically to one populated retroactively.
from backfill_stock_search import size_bucket_for, build_search_tsv

# Force line-buffered stdout so progress lines appear in real time when the
# script is piped (e.g. `python3 ... | tee log.txt`). Without this, Python
# switches to block buffering on a pipe and the terminal stays silent until
# the whole run finishes — masking the 1h+ analyzer wait entirely.
try:
    sys.stdout.reconfigure(line_buffering=True)
except AttributeError:
    pass  # Older Python without reconfigure; PYTHONUNBUFFERED=1 works as fallback.

# Load environment variables from project root
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
if os.path.exists(os.path.join(PROJECT_ROOT, '.env.local')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env'))

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
INTERNAL_SECRET = os.getenv('DEEPMONEY_INTERNAL_SECRET')
NEXTAUTH_URL = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
OLLAMA_BASE_URL = os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434')
OLLAMA_ENABLED = (os.getenv('OLLAMA_ENABLED', 'false') or '').strip().lower() == 'true'
# Scripts always run on the same machine as Next.js, so call localhost directly
# to bypass nginx and its 60s proxy timeout. The deepmoney route can take 2+ min.
INTERNAL_API_URL = 'http://localhost:3001'
API_URL = f"{INTERNAL_API_URL}/api/prediction/deepmoney?refresh=true"
WB_API_URL = f"{INTERNAL_API_URL}/api/worldbank"

# Drop stocks priced above this floor. BRK-A trades ~$700k/share and similar
# class-A names show up via the sector-leader override lane; their GPS is
# irrelevant to anyone who can't afford one share. Filter is applied to both
# the regular ranker-survivor path and the sector-leader fast path, so these
# stocks never reach recommended_stocks or stock_gps_scores.
PRICE_CEILING_USD = 100_000

# Analyst-grade override lane: minimum composite score (A-) to qualify.
# Vol-gate discounts are applied when a stock has a grade at or above this.
ANALYST_GRADE_MIN_COMPOSITE = 82

# Minimum absolute pre/post market move (in %) for a stock to surface as an
# "Off Market Mover" on the dashboard. Adjust here if the section feels noisy.
OFF_MARKET_MIN_CHANGE_PCT = 3.0


def upsert_stock_with_search_fields(cursor, ticker, company_name, price,
                                    market_cap, sector, industry):
    """Ensure `stocks` has a row for `ticker` with search-index fields populated.

    Returns the row's `stock_id`. Newly-inserted rows get sector/industry/
    size_bucket/search_tsv set immediately so the ticker is searchable via
    /api/search on the very next request — no waiting for a backfill run.
    Existing rows get their search fields refreshed when we have fresh values
    (market_cap can move a stock between size buckets over time).
    """
    bucket, size_tokens = size_bucket_for(market_cap)
    tsv = build_search_tsv(ticker, company_name, sector, industry, size_tokens)

    cursor.execute("SELECT id FROM stocks WHERE symbol = %s", (ticker,))
    row = cursor.fetchone()
    if row:
        stock_id = row[0]
        cursor.execute(
            """
            UPDATE stocks
               SET company_name = COALESCE(%s, company_name),
                   price        = COALESCE(%s, price),
                   market_cap   = COALESCE(%s, market_cap),
                   sector       = COALESCE(%s, sector),
                   industry     = COALESCE(%s, industry),
                   size_bucket  = COALESCE(%s, size_bucket),
                   search_tsv   = %s
             WHERE id = %s
            """,
            (company_name, price, market_cap, sector, industry, bucket, tsv, stock_id),
        )
        return stock_id

    cursor.execute(
        """
        INSERT INTO stocks
            (symbol, company_name, price, market_cap,
             sector, industry, size_bucket, search_tsv)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (ticker, company_name, price, market_cap, sector, industry, bucket, tsv),
    )
    return cursor.lastrowid


# Global cache for market indices
_indices_cache = None

def get_market_indices(headers: dict) -> dict | None:
    """Fetch major indices from the internal API with local caching."""
    global _indices_cache
    if _indices_cache is not None:
        return _indices_cache
    
    url = f"{INTERNAL_API_URL}/api/market/indices"
    print(f"  [indices] Fetching major indices from {url}...")
    try:
        response = requests.get(url, headers=headers)
        
        # Handle environment variable quote mismatch
        if response.status_code == 401 and INTERNAL_SECRET:
            if not (INTERNAL_SECRET.startswith('"') and INTERNAL_SECRET.endswith('"')):
                print("  [indices] Retrying with quoted secret...")
                headers['x-api-key'] = f'"{INTERNAL_SECRET}"'
                response = requests.get(url, headers=headers)
        
        response.raise_for_status()
        _indices_cache = response.json()
        return _indices_cache
    except Exception as e:
        print(f"  [indices] Warning: Error fetching market indices: {e}")
        return None

def check_ollama_available() -> bool:
    """Pre-flight reachability check for the local Ollama server.

    The actual NER pass runs server-side inside the Node API; this is just
    an observational probe so the run summary can report whether Ollama
    would have been reachable from the host that owns the sync. 2s timeout
    keeps the pre-flight cheap when Ollama isn't installed.
    """
    try:
        response = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=2)
        return response.status_code == 200
    except Exception:
        return False


def fetch_world_bank_data(headers: dict) -> dict | None:
    """Fetch consolidated World Bank data."""
    print(f"  [macro] Fetching World Bank data from {WB_API_URL}...")
    try:
        response = requests.get(WB_API_URL, headers=headers)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"  [macro] Warning: Error fetching World Bank data: {e}")
        return None

def _yahoo_session_with_crumb() -> tuple:
    """Return (requests.Session, crumb_str) authenticated for Yahoo Finance v7.

    Yahoo Finance requires a valid browser cookie + crumb since mid-2024.
    Flow: visit finance.yahoo.com to get cookies, then hit the crumb endpoint.
    Returns (None, None) if the handshake fails.
    """
    _BROWSER_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }
    try:
        session = requests.Session()
        session.headers.update(_BROWSER_HEADERS)
        # Step 1: visit Yahoo Finance to receive session cookies
        session.get("https://finance.yahoo.com", timeout=15)
        # Step 2: fetch the crumb that must accompany every v7 API call
        crumb_resp = session.get(
            "https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=10
        )
        crumb = crumb_resp.text.strip()
        if not crumb or crumb.startswith("<"):
            # HTML response means consent wall or block — crumb unusable
            return None, None
        return session, crumb
    except Exception as e:
        print(f"  [off-market] Yahoo session/crumb handshake failed: {e}")
        return None, None


def fetch_extended_hours_quotes(tickers: list) -> list:
    """Batch-fetch pre/post market quotes from Yahoo Finance v7 quotes API.

    Returns a list of quote dicts with marketState, preMarketPrice,
    preMarketChangePercent, postMarketPrice, postMarketChangePercent, etc.
    Falls back gracefully on network errors.
    """
    session, crumb = _yahoo_session_with_crumb()
    if session is None:
        print("  [off-market] Could not authenticate with Yahoo Finance — skipping off-market movers.")
        return []

    results = []
    batch_size = 100
    for i in range(0, len(tickers), batch_size):
        batch = tickers[i : i + batch_size]
        symbols = ",".join(batch)
        url = (
            "https://query1.finance.yahoo.com/v7/finance/quote"
            f"?symbols={symbols}"
            "&fields=marketState,preMarketPrice,preMarketChangePercent,"
            "postMarketPrice,postMarketChangePercent,regularMarketPrice,"
            f"shortName,longName&crumb={crumb}"
        )
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
            batch_results = resp.json().get("quoteResponse", {}).get("result", [])
            results.extend(batch_results)
        except Exception as e:
            print(f"  [off-market] Yahoo Finance batch fetch failed (batch {i // batch_size + 1}): {e}")
    return results


def sync_off_market_movers(cursor, tickers: list, today: str, counters: dict) -> None:
    """Check all sync-run tickers for pre/post market moves and write qualifying
    rows to recommended_stocks with type='off_market_mover'.

    Threshold: OFF_MARKET_MIN_CHANGE_PCT (absolute, in %).
    Yahoo Finance returns preMarketChangePercent in decimal (0.025 = 2.5%),
    so we multiply by 100 before comparing.
    """
    print("Checking for off-market movers...")

    quotes = fetch_extended_hours_quotes(tickers)

    if quotes:
        sample_states = list({q.get("marketState", "?") for q in quotes[:20]})
        print(f"  [off-market] {len(quotes)} quotes received; market states in sample: {sample_states}")

    movers = []
    for q in quotes:
        market_state = q.get("marketState", "")
        if market_state == "PRE":
            raw_pct  = q.get("preMarketChangePercent")
            ext_price = q.get("preMarketPrice")
            label     = "Pre-Market"
            source    = "pre_market"
        elif market_state in ("POST", "POSTPOST", "PREPRE"):
            # POSTPOST = post-market session fully closed but Yahoo still holds
            # postMarketPrice/postMarketChangePercent from the evening session.
            # PREPRE   = overnight (midnight–4 AM ET); same post-market data is
            # still present and reflects the prior day's after-hours move.
            # Both are treated the same as POST for mover detection.
            raw_pct   = q.get("postMarketChangePercent")
            ext_price = q.get("postMarketPrice")
            label     = "After-Hours"
            source    = "after_hours"
        else:
            continue

        if raw_pct is None or ext_price is None:
            continue

        # Yahoo v7 returns preMarketChangePercent / postMarketChangePercent
        # already in percent (e.g. 2.5 = 2.5%), NOT as a decimal fraction.
        change_pct = raw_pct
        if abs(change_pct) < OFF_MARKET_MIN_CHANGE_PCT:
            continue

        # Normalise extended-state variants → canonical PRE/POST for storage;
        # the front-end reads discovery_source, not market_state.
        stored_state = "POST" if market_state in ("POSTPOST", "PREPRE") else market_state

        movers.append({
            "ticker":       (q.get("symbol") or "").upper(),
            "company_name": q.get("longName") or q.get("shortName") or q.get("symbol", ""),
            "current_price": ext_price,
            "market_state":  stored_state,
            "change_pct":    change_pct,
            "source":        source,
            "label":         label,
        })

    # Sort by absolute move descending so the biggest movers come first.
    movers.sort(key=lambda x: abs(x["change_pct"]), reverse=True)

    # Replace any previous off_market_mover rows for today's snapshot.
    cursor.execute(
        "DELETE FROM recommended_stocks WHERE type = 'off_market_mover' AND snapshot_date = %s",
        (today,),
    )

    if not movers:
        print(f"  No off-market movers found (threshold: {OFF_MARKET_MIN_CHANGE_PCT}%)")
        counters["off_market_movers"] = 0
        return

    off_market_insert = """
    INSERT INTO recommended_stocks
    (
        type, ticker, company_name, current_price, gps_score, gps_breakdown, classification,
        analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct,
        market_cap_m, mention_count, discovery_source, trading_signal,
        trading_signal_score, upcoming_earnings, prediction_input,
        trailing_pe, price_to_book, metric_value, metric_label, snapshot_date
    )
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """

    for m in movers:
        cursor.execute(off_market_insert, (
            "off_market_mover",          # type
            m["ticker"],                 # ticker
            m["company_name"],           # company_name
            m["current_price"],          # current_price (extended hours)
            None,                        # gps_score
            None,                        # gps_breakdown
            "Off Market Mover",          # classification
            None,                        # analyst_upside_pct
            None,                        # revenue_growth_yoy
            None,                        # gross_margin_pct
            None,                        # rd_spend_pct
            None,                        # market_cap_m
            None,                        # mention_count
            m["source"],                 # discovery_source  ('pre_market'|'after_hours')
            m["market_state"],           # trading_signal    ('PRE'|'POST')
            None,                        # trading_signal_score
            None,                        # upcoming_earnings
            None,                        # prediction_input
            None,                        # trailing_pe
            None,                        # price_to_book
            round(m["change_pct"], 4),   # metric_value  (change %)
            m["label"],                  # metric_label  ('Pre-Market'|'After-Hours')
            today,                       # snapshot_date
        ))
        print(f"  > Off-market mover: {m['ticker']} ({m['label']}: {m['change_pct']:+.2f}%)")

    counters["off_market_movers"] = len(movers)
    print(f"  Off-market movers written: {len(movers)}")


def sync_fred_data(cursor) -> int:
    """Fetch FRED series and upsert into fred_macro_indicators. Returns count synced."""
    fred_api_key = os.getenv('FRED_API_KEY', '')
    if not fred_api_key:
        print("  [fred] Skipping — FRED_API_KEY not set")
        return 0

    ensure_table(cursor)
    synced = 0
    for cfg in SERIES_CONFIG:
        try:
            row = compute_row(cfg)
            if row is None:
                print(f"  [fred] {cfg['name']}: no data")
                continue
            upsert_indicator(cursor, row)
            synced += 1
            time.sleep(0.1)
        except Exception as e:
            print(f"  [fred] Warning: {cfg['name']}: {e}")
    print(f"  [fred] Synced {synced}/{len(SERIES_CONFIG)} series")
    return synced


def sync_deepmoney():
    print(f"[{datetime.now()}] Starting DeepMoney sync...")

    # ── Run-level counters for the end-of-run summary ─────────────────────
    # Initialized up here so they're always defined, even when an exception
    # short-circuits the work before they'd otherwise be set.
    run_start = time.time()
    counters = {
        "price_ceiling_rejected":0,   # dropped because price > PRICE_CEILING_USD
        "vol_gate_rejected":     0,   # MLP confidence-vs-beta gate
        "stocks_written":        0,   # rows inserted into recommended_stocks
        "gps_updated":           0,   # stock_gps_scores rows updated (score changed)
        "gps_unchanged":         0,   # stock_gps_scores rows skipped (same score)
        "dashboard_qualified":   0,   # stocks meeting MLP-confidence dashboard gate
        "ath_warnings":          0,   # high-beta near-ATH stocks flagged
        "etf_holdings_written":  0,   # rows inserted from ETF holdings pass
        "stale_cleaned":         0,   # discovery rows removed in cleanup pass
        "earnings_cal_seen":     0,   # tickers surfaced by NASDAQ earnings calendar
        "earnings_cal_added":    0,   # of those, rows newly inserted into `stocks`
        "active_users":          0,
        "hot_etfs":              0,
        "stocks_in_api_resp":    0,
        # Pre-flight observational state for the Ollama NER pass; the actual
        # work runs server-side so the API echoes its own counters back via
        # meta.ollamaPass — this is just whether the host could reach Ollama.
        "ollama_preflight":      "disabled" if not OLLAMA_ENABLED else "unknown",
    }
    meta_snapshot: dict = {}  # cached API meta for the summary block
    # Captures per-stock detail for the final summary table. Initialized here
    # (not inside the try) so the finally block can always read it even when
    # an exception fires before any stock qualifies.
    qualifying_stocks_details: list[dict] = []

    # Sequential 1-month prediction gate — not driven by DEEPMONEY_ALGORITHM
    # (kept at 1.5% per legacy behavior); the dashboard push is now gated by
    # the MLP confidence floor from the resolved algorithm preset instead of
    # by a GPS threshold.
    pred_threshold = 1.5

    # ── Algorithm preset (resolved server-side, echoed in meta.algorithm) ──
    # Defaults are a safety net for old cached API responses that pre-date
    # the meta.algorithm field; under normal operation the API always emits
    # the resolved preset and these are never used.
    algorithm_level         = 5
    mlp_confidence_floor    = 60.0
    vol_gate_floor          = 70.0
    print(f"  [config] Prediction Gate (>= {pred_threshold}%) — gates resolved from meta.algorithm")
    
    # 1. Fetch data from API (V2)
    # Ensure secret is clean
    secret = INTERNAL_SECRET.strip('"') if INTERNAL_SECRET else ""
    headers = {'x-api-key': secret}

    # Pre-flight Ollama check (observational only — the actual NER pass runs
    # inside the deepmoney API). Records "enabled" / "disabled" / "failed"
    # for the run summary.
    if OLLAMA_ENABLED:
        if check_ollama_available():
            counters["ollama_preflight"] = "enabled"
            print(f"  [ollama] Pre-flight reachable at {OLLAMA_BASE_URL}")
        else:
            counters["ollama_preflight"] = "failed"
            print(f"  [ollama] Pre-flight FAILED — {OLLAMA_BASE_URL} unreachable")

    # Fetch World Bank data for DB persistence only
    wb_data = fetch_world_bank_data(headers)

    try:
        print(f"  [api] Requesting deepmoney analysis from {API_URL}...")
        response = requests.get(API_URL, headers=headers)
        response.raise_for_status()
        data = response.json()

        # Print debug metadata if available
        meta = data.get('meta', {})
        debug = meta.get('debug', {})
        meta_snapshot = meta

        # Resolve the algorithm preset from the API response. Falls back to
        # the safety-net defaults set above only if meta.algorithm is missing
        # (e.g. an old cached response).
        algorithm = meta.get('algorithm') or {}
        # Fractional levels (e.g. 1.5, 3.7) are accepted server-side and
        # interpolated linearly into the preset values; the level here is
        # display-only so we keep it as a float for accurate logging.
        algorithm_level      = float(algorithm.get('level', algorithm_level))
        mlp_confidence_floor = float(algorithm.get('mlpConfidenceFloor', mlp_confidence_floor))
        vol_gate_floor       = float(algorithm.get('volGateFloor', vol_gate_floor))
        ranker_keep_pct      = float(algorithm.get('rankerKeepPct', 0.25))
        print(f"  [algorithm] level={algorithm_level:g} rankerKeepPct={ranker_keep_pct:.3f} "
              f"mlpConfidenceFloor={mlp_confidence_floor:.1f} volGateFloor={vol_gate_floor:.1f}")

        if debug:
            print(f"  [debug] Enrichment Rejected: {debug.get('rejectedEnrichment')}")
            print(f"  [debug] Signal Score Rejected: {debug.get('rejectedSignalScore')}")
            print(f"  [debug] History Rejected (<100d): {debug.get('rejectedHistory')}")
            print(f"  [debug] Passed to Analyzer: {debug.get('passedToAnalyzer')}")
            print(f"  [debug] Rejected by Ranker: {debug.get('rejectedByRanker')}")
            rs = debug.get('rankerSurvivorCount')
            rf = debug.get('rankerFellThrough')
            if rs is not None:
                tag = "  [!! FELL THROUGH]" if rf else ""
                print(f"  [debug] Ranker Survivors: {rs}{tag}")
            lm_p = debug.get('lightModelPassed')
            lm_f = debug.get('lightModelFiltered')
            if lm_p is not None:
                print(f"  [debug] Light Model: {lm_p} passed, {lm_f} filtered")
            print(f"  [debug] Final Filtered Count: {debug.get('filteredCount')}")
            print(f"  [debug] ETF Holdings Surfaced: {meta.get('etfHoldingsSurfacedCount')}")
            print(f"  [debug] Popular-ETF Holdings Merged: {meta.get('etfPopularHoldingsCount')}")
            print(f"  [debug] Trending 48h Merged: {debug.get('trendingTickerCount')}")
            print(f"  [debug] Trending 48h Surfaced (override lane): {debug.get('trending48hSurfaced')}")
    except Exception as e:
        print(f"Error fetching data from API: {e}")
        return

    # 2. Connect to database
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_DATABASE
        )
        cursor = conn.cursor()
    except Exception as e:
        print(f"Error connecting to database: {e}")
        return

    today = datetime.now().strftime('%Y-%m-%d')

    try:
        # 3.0 Idempotent schema additions for Path-A ranker integration.
        # Adds gps_score_type ('light'|'full'), ranker_score (0..1 percentile),
        # and hist_vol_30 (annualized 30d vol) to both recommended_stocks and
        # stock_gps_scores. MySQL 8 doesn't support `ADD COLUMN IF NOT EXISTS`
        # (that's MariaDB-only), so we issue one ALTER per column and swallow
        # errno 1060 ("Duplicate column name") to stay idempotent across reruns.
        ranker_schema_columns = [
            ("recommended_stocks", "gps_score_type", "ENUM('light','full') NOT NULL DEFAULT 'full'"),
            ("recommended_stocks", "ranker_score",   "DECIMAL(6,4) NULL"),
            ("recommended_stocks", "hist_vol_30",    "DECIMAL(8,4) NULL"),
            ("stock_gps_scores",   "gps_score_type", "ENUM('light','full') NOT NULL DEFAULT 'full'"),
            ("stock_gps_scores",   "ranker_score",   "DECIMAL(6,4) NULL"),
            ("stock_gps_scores",   "hist_vol_30",    "DECIMAL(8,4) NULL"),
        ]
        for table, column, defn in ranker_schema_columns:
            try:
                cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {defn}")
            except mysql.connector.Error as e:
                if e.errno != 1060:  # 1060 = duplicate column → already present
                    raise

        # Snapshot the prior dashboard ticker set BEFORE the wipe so we can
        # reconcile it against the incoming set at the end and update
        # dashboard_tenure (see the tenure block after the ETF-holdings loop).
        # Only 'hot_stocks' rows are tracked — ETF holdings rotate on their own
        # cadence via the parent ETF list and aren't the noisy names the
        # rotation was designed to demote.
        cursor.execute(
            "SELECT ticker FROM recommended_stocks WHERE type = 'hot_stocks'"
        )
        prior_dashboard_tickers = {row[0] for row in cursor.fetchall()}

        # Save full rows for hot_stocks tickers that won't be re-processed this
        # run (GPS-fresh stocks skipped by the 12h gate). The wipe below would
        # otherwise silently remove their dashboard entries even though nothing
        # about them changed. We restore these rows immediately after the wipe.
        processed_ticker_set = {s.get('ticker') for s in data.get('stocks', [])}
        _restore_cols = (
            'trading_signal', 'trading_signal_score', 'type', 'parent_etf_ticker',
            'holding_percent', 'ticker', 'company_name', 'current_price', 'gps_score',
            'gps_breakdown', 'bearish_signal', 'classification', 'analyst_upside_pct',
            'revenue_growth_yoy', 'gross_margin_pct', 'rd_spend_pct', 'trailing_pe',
            'price_to_book', 'metric_value', 'metric_label', 'market_cap_m',
            'mention_count', 'discovery_source', 'upcoming_earnings', 'prediction_input',
            'snapshot_date', 'gps_score_type', 'ranker_score', 'hist_vol_30',
        )
        cursor.execute(
            f"SELECT {', '.join(_restore_cols)} FROM recommended_stocks WHERE type = 'hot_stocks'"
        )
        _all_hot = cursor.fetchall()
        _ticker_idx = _restore_cols.index('ticker')
        fresh_skipped_hot_rows = [
            row for row in _all_hot
            if row[_ticker_idx] not in processed_ticker_set
        ]

        # 3. Clear existing recommendation data
        print("Clearing existing recommendation data...")
        cursor.execute("DELETE FROM recommended_stocks")

        # Restore GPS-fresh hot_stocks rows that were not re-evaluated this run.
        if fresh_skipped_hot_rows:
            import json as _json
            _json_cols = {'gps_breakdown', 'prediction_input'}
            _restore_ph = ', '.join(['%s'] * len(_restore_cols))
            _restore_q  = (
                f"INSERT INTO recommended_stocks ({', '.join(_restore_cols)}) "
                f"VALUES ({_restore_ph})"
            )
            _restored_ok = 0
            for _row in fresh_skipped_hot_rows:
                _ticker_val = _row[_ticker_idx]
                try:
                    # mysql.connector returns JSON columns as Python dicts/lists;
                    # re-insert requires them serialized back to strings.
                    _row_fixed = tuple(
                        _json.dumps(v) if (isinstance(v, (dict, list)) and _restore_cols[i] in _json_cols) else v
                        for i, v in enumerate(_row)
                    )
                    cursor.execute(_restore_q, _row_fixed)
                    _restored_ok += 1
                except Exception as _re:
                    print(f"  [restore-warn] Could not restore {_ticker_val}: {_re}")
            print(f"  Restored {_restored_ok} GPS-fresh dashboard stock(s) from prior run.")

        # 3.1 Persist Macro Context Snapshot (Phase 4)
        if wb_data and wb_data.get('success'):
            print("Persisting macro context snapshot...")
            macro = wb_data.get('macro', {}).get('indicators', {})
            risk = wb_data.get('risk_index', {})
            
            cursor.execute("""
                INSERT INTO macro_context_snapshots 
                (snapshot_date, global_health_score, unemployment_rate, unemployment_signal, inflation_rate, gdp_growth)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                global_health_score = VALUES(global_health_score),
                unemployment_rate = VALUES(unemployment_rate),
                unemployment_signal = VALUES(unemployment_signal),
                inflation_rate = VALUES(inflation_rate),
                gdp_growth = VALUES(gdp_growth)
            """, (
                today,
                risk.get('globalHealthScore'),
                macro.get('unemployment', {}).get('latest'),
                macro.get('unemployment', {}).get('signal'),
                macro.get('inflation', {}).get('latest'),
                macro.get('gdpGrowth', {}).get('latest')
            ))

        # 3.2 Sync FRED macro indicators
        print("Syncing FRED macro indicators...")
        sync_fred_data(cursor)
        conn.commit()

        # 3.5 Fetch all approved users (so new users see recommendations on first login)
        print("Fetching approved users...")
        cursor.execute("SELECT id FROM users WHERE approval_status = 'approved'")
        active_user_ids = [row[0] for row in cursor.fetchall()]
        counters["active_users"] = len(active_user_ids)
        print(f"Found {len(active_user_ids)} approved users.")

        # 3.6 Earnings-calendar backfill.
        # The Node discovery pass surfaces every ticker with an upcoming
        # earnings print (next 5 business days from the NASDAQ calendar).
        # Tickers that survive the analyzer already get a full stocks row via
        # upsert_stock_with_search_fields below, but many won't survive — e.g.
        # thin float, insufficient history — and we still want them in the
        # `stocks` master so search + earnings widgets can resolve them.
        # Insert bare rows here (symbol + company_name only); the next
        # backfill_stock_search run will fill sector/industry/size_bucket.
        earnings_entries = meta.get('earningsCalendarTickers') or []
        counters["earnings_cal_seen"] = len(earnings_entries)
        if earnings_entries:
            print(f"Backfilling {len(earnings_entries)} earnings-calendar tickers into stocks table...")
            for entry in earnings_entries:
                symbol = (entry.get('symbol') or '').strip().upper()
                if not symbol:
                    continue
                company_name = (entry.get('name') or '').strip() or symbol
                cursor.execute("SELECT id FROM stocks WHERE symbol = %s", (symbol,))
                if cursor.fetchone():
                    continue
                # Bare insert: NOT NULL columns only. search_tsv left empty;
                # backfill_stock_search will populate it on its next pass.
                cursor.execute(
                    "INSERT INTO stocks (symbol, company_name) VALUES (%s, %s)",
                    (symbol, company_name),
                )
                counters["earnings_cal_added"] += 1
            print(f"  {counters['earnings_cal_added']} new stocks-table rows inserted; "
                  f"{counters['earnings_cal_seen'] - counters['earnings_cal_added']} already present.")

        # EDGAR 8-K backfill — same pattern as earnings calendar
        edgar_entries = meta.get('edgarBackfillEntries') or []
        counters["edgar_backfill_seen"] = len(edgar_entries)
        edgar_added = 0
        for entry in edgar_entries:
            sym  = (entry.get('symbol') or '').strip().upper()
            name = (entry.get('name') or sym).strip()
            if not sym:
                continue
            cursor.execute("SELECT id FROM stocks WHERE symbol = %s LIMIT 1", (sym,))
            if not cursor.fetchone():
                try:
                    cursor.execute(
                        "INSERT IGNORE INTO stocks (symbol, company_name) VALUES (%s, %s)",
                        (sym, name[:255]),
                    )
                    edgar_added += 1
                except Exception:
                    pass
        counters["edgar_backfill_added"] = edgar_added

        # 4. Process Stocks from (stocks array)
        stocks = data.get('stocks', [])
        counters["stocks_in_api_resp"] = len(stocks)
        # Full ticker universe for the off-market mover check later.
        all_processed_tickers = [s.get("ticker", "") for s in stocks if s.get("ticker")]
        qualifying_stock_ids: set = set()
        print(f"Processing {len(stocks)} hot stocks...")
        
        # COLUMN ORDER MUST MATCH VALUES IN CURSOR.EXECUTE
        insert_query = """
        INSERT INTO recommended_stocks
        (
            type, ticker, company_name, current_price, gps_score, gps_breakdown, classification,
            analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct,
            market_cap_m, mention_count, discovery_source, trading_signal,
            trading_signal_score, upcoming_earnings, prediction_input,
            trailing_pe, price_to_book, metric_value, metric_label, snapshot_date
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        
        total_stocks = len(stocks)
        for idx, s in enumerate(stocks, start=1):
            ticker = s.get('ticker')
            # Progress heartbeat — the analysis pass can run for tens of minutes;
            # without this, the log looks stalled between ticker outputs when a
            # stock gets skipped early (price ceiling, vol gate) with no other
            # per-ticker log line.
            print(f"  [{idx}/{total_stocks}] Processing {ticker}...")
            gps = s.get('gps_score', 0)
            gps_breakdown = s.get('gps_breakdown') or {}
            pred_input = s.get('prediction_input') or {}

            # Prediction metrics (Extraction from prediction_input)
            predicted_change_pct = pred_input.get('predicted_change_pct')
            if predicted_change_pct is None:
                predicted_change_pct = pred_input.get('predicted_change_pct_1m')
            predicted_change_pct = predicted_change_pct or 0

            # Per-horizon predicted prices — pulled up here so we can persist
            # them to analytics *before* any gating drops the stock.
            price = s.get('price')

            # Price-ceiling gate — drop class-A / ultra-high-share-price names
            # (e.g. BRK-A) before any downstream write. Applies to both the
            # regular path and the sector-leader fast path.
            if price and price > PRICE_CEILING_USD:
                print(f"  [price-ceiling] SKIP {ticker}: ${price:,.0f} > ${PRICE_CEILING_USD:,}")
                counters["price_ceiling_rejected"] += 1
                continue

            predicted_price_1w = pred_input.get('predicted_price_1w')
            predicted_price_1m = pred_input.get('predicted_price_1m')
            if predicted_price_1m is None:
                predicted_price_1m = pred_input.get('predicted_price')
            predicted_price_6m = pred_input.get('predicted_price_6m')
            predicted_price_3m = pred_input.get('predicted_price_3m')

            # Record to analytics prediction_records table BEFORE the vol-gate
            # check. Every ranker survivor has a real per-horizon prediction;
            # recording the rejects too lets us audit how well the floor was
            # calibrated (was the model right to be confident?).
            if price and (predicted_price_1w or predicted_price_1m or predicted_price_6m or predicted_price_3m):
                record_prediction(
                    symbol=ticker,
                    price_at_prediction=price,
                    predicted_price_1w=predicted_price_1w,
                    predicted_price_1m=predicted_price_1m,
                    predicted_price_6m=predicted_price_6m,
                    predicted_price_3m=predicted_price_3m,
                    predicted_change_pct_1w=pred_input.get('predicted_change_pct_1w'),
                    predicted_change_pct_1m=pred_input.get('predicted_change_pct_1m') or pred_input.get('predicted_change_pct'),
                    predicted_change_pct_6m=pred_input.get('predicted_change_pct_6m'),
                    predicted_change_pct_3m=pred_input.get('predicted_change_pct_3m'),
                    confidence_score_1w=pred_input.get('confidence_score_1w'),
                    confidence_score_1m=pred_input.get('confidence_score_1m') or pred_input.get('confidence_score'),
                    confidence_score_6m=pred_input.get('confidence_score_6m'),
                    confidence_score_3m=pred_input.get('confidence_score_3m'),
                    gps_score=gps,
                    gps_breakdown=gps_breakdown if gps_breakdown else None,
                    accuracy_metrics=pred_input.get('accuracy_metrics'),
                    data_quality=pred_input.get('data_quality'),
                    model_status=pred_input.get('model_status'),
                    at_model_ceiling_6m=pred_input.get('at_model_ceiling_6m'),
                    at_model_ceiling_3m=pred_input.get('at_model_ceiling_3m'),
                    ceiling_direction=pred_input.get('ceiling_direction'),
                    confidence_breakdown=pred_input.get('confidence_breakdown'),
                    confidence_reason_1w=pred_input.get('confidence_reason_1w'),
                    confidence_reason_1m=pred_input.get('confidence_reason_1m'),
                    confidence_reason_6m=pred_input.get('confidence_reason_6m'),
                    confidence_reason_3m=pred_input.get('confidence_reason_3m'),
                    model_version='deepmoney_sync',
                )

            # 4.1 (removed) Per-stock GPS gate — the LightGBM ranker already
            #     filtered the universe server-side via algorithm.rankerKeepPct;
            #     every stock arriving here is a ranker survivor.

            # Sector-leader and trending-48h are both *coverage feeds* — they
            # exist to populate stock_gps_scores so /search/industry/[sector]
            # and the /search trending grid can render a GPS rating. Neither
            # belongs in recommended_stocks (the dashboard recommendation
            # table). Both ALWAYS take the GPS-only fast path; the vol-gate
            # is logged for diagnostic purposes but does not change routing.
            is_sector_leader = s.get('discovery_source') == 'sector_leader'
            is_trending_48h  = s.get('discovery_source') == 'trending_48h'
            is_unusual_options    = s.get('discovery_source') == 'unusual_options'
            is_insider_cluster    = s.get('discovery_source') == 'insider_cluster'
            is_revision_momentum  = s.get('discovery_source') == 'revision_momentum'
            is_short_squeeze      = s.get('discovery_source') == 'short_squeeze_setup'
            is_volume_breakout    = s.get('discovery_source') == 'volume_breakout'
            is_sec_8k             = s.get('discovery_source') == 'sec_8k_event'

            # 4.2 Confidence-vs-beta gate driven by the algorithm preset.
            # High-beta stocks (beta > 2.5) face the stricter volGateFloor;
            # everything else faces the mlpConfidenceFloor. The skip tag in
            # the log distinguishes which floor fired so we can audit runs.
            conf_score = pred_input.get('confidence_score') or pred_input.get('confidence_score_1m') or 0
            beta_val = s.get('beta') or 1.0
            high_beta = beta_val > 2.5
            confidence_floor = vol_gate_floor if high_beta else mlp_confidence_floor
            floor_label = "vol-floor" if high_beta else "mlp-floor"

            # Analyst-grade vol-gate discount: stocks that qualified for the
            # analyst override lane (composite ≥ A-) get a lower confidence
            # floor. The discount scales with grade — A+ gets more headroom
            # than A-, reflecting that stronger analyst consensus is a partial
            # substitute for MLP confidence on volatile names.
            analyst_composite = s.get('analystGradeComposite') or 0
            if analyst_composite >= 93:        # A+
                grade_discount = 20
            elif analyst_composite >= 87:      # A
                grade_discount = 15
            elif analyst_composite >= ANALYST_GRADE_MIN_COMPOSITE:  # A-
                grade_discount = 10
            else:
                grade_discount = 0
            effective_floor = max(0, confidence_floor - grade_discount)
            effective_label = f"{floor_label}(grade-adj-{grade_discount})" if grade_discount else floor_label

            # Coverage feeds that bypass vol-gate entirely: sector_leader always bypasses.
            # New signal lanes that should fall through on vol-gate failure (like trending):
            # unusual_options and sec_8k_event — we want GPS coverage even on bearish signals.
            # Short-squeeze gets a 15-point discount (squeeze setups are inherently high-vol).
            squeeze_discount = 15 if is_short_squeeze else 0
            effective_floor_final = max(0, effective_floor - squeeze_discount)

            vol_gate_failed = conf_score < effective_floor_final and not is_sector_leader
            if grade_discount and not vol_gate_failed and conf_score < confidence_floor:
                # Stock would have been rejected without the grade discount — log it.
                analyst_grade = s.get('analystGrade', '?')
                print(f"  [vol-gate] PASS {ticker} via grade discount ({analyst_grade}/{analyst_composite:.0f}): "
                      f"CS {conf_score} >= adj-floor {effective_floor} (base {confidence_floor}, -({grade_discount}))")
            if vol_gate_failed:
                cs_1w = pred_input.get('confidence_score_1w')
                cs_6m = pred_input.get('confidence_score_6m')
                cs_3m = pred_input.get('confidence_score_3m')
                reason_1m = pred_input.get('confidence_reason_1m') or ''
                reason_suffix = f"  reason={reason_1m[:80]!r}" if reason_1m else ''
                print(f"  [vol-gate] SKIP {ticker} ({effective_label}): CS {conf_score} < floor {effective_floor_final} (beta {beta_val:.2f})"
                      f"  [all-horizons: 1w={cs_1w} 1m={conf_score} 6m={cs_6m} 3m={cs_3m}]{reason_suffix}")
                counters["vol_gate_rejected"] += 1
                if not (is_trending_48h or is_unusual_options or is_sec_8k):
                    continue
                # Trending / unusual_options / sec_8k vol-gate failure falls through to fast path.

            if is_sector_leader or is_trending_48h or is_unusual_options or is_insider_cluster \
                    or is_revision_momentum or is_short_squeeze or is_volume_breakout or is_sec_8k:
                # Fast-path: refresh stocks + stock_gps_scores only, skip
                # recommended_stocks insert + dashboard gate. Both coverage
                # feeds take this path regardless of vol-gate outcome —
                # bearish trending stocks must not pollute recommended_stocks.
                label = (
                    "sector-leader"     if is_sector_leader    else
                    "unusual-options"   if is_unusual_options  else
                    "insider-cluster"   if is_insider_cluster  else
                    "revision-momentum" if is_revision_momentum else
                    "short-squeeze"     if is_short_squeeze    else
                    "volume-breakout"   if is_volume_breakout  else
                    "sec-8k"            if is_sec_8k           else
                    "trending-48h"
                )
                stock_id = upsert_stock_with_search_fields(
                    cursor,
                    ticker,
                    s.get('name'),
                    s.get('price'),
                    s.get('marketCap'),
                    s.get('sector'),
                    s.get('industry'),
                )
                cursor.execute("""
                    INSERT INTO stock_gps_scores (stock_id, as_of, gps_score, gps_breakdown, source)
                    VALUES (%s, NOW(), %s, %s, 'deepmoney_sync')
                    ON DUPLICATE KEY UPDATE
                        as_of         = VALUES(as_of),
                        gps_score     = VALUES(gps_score),
                        gps_breakdown = VALUES(gps_breakdown),
                        source        = VALUES(source)
                """, (stock_id, gps, json.dumps(gps_breakdown)))
                counters["gps_updated"] += 1
                print(f"  > [{label}] {ticker} GPS {round(float(gps), 1)} (pred {predicted_change_pct:+.2f}%, CS {conf_score})")
                continue

            counters["stocks_written"] += 1
            print(f"  > {ticker} (GPS: {gps}, Pred: {predicted_change_pct}%)")

            # Map V2 fields to DB variables
            stock_type = "hot_stocks"
            name = s.get('name')
            classification = s.get('sector', 'Unknown')

            # Scaling
            upside = (s.get('analystUpside') or 0) * 100
            rev_growth = (s.get('revenueGrowth') or 0) * 100
            margin = (s.get('grossMargins') or 0) * 100

            total_rev = s.get('totalRevenue') or 0
            rd_spend = s.get('researchDevelopment') or 0
            rd_pct = min((rd_spend / total_rev) * 100, 999999.99) if total_rev > 0 else 0

            market_cap_m = (s.get('marketCap') or 0) / 1e6

            metric_val = predicted_change_pct
            metric_lbl = f"CS: {pred_input.get('confidence_score')}" if pred_input.get('confidence_score') is not None else None

            # ATH proximity warning flag
            hi_ratio = s.get('hiRatio52w') or 0
            if hi_ratio > 0.97 and beta_val > 2.0:
                counters["ath_warnings"] += 1
                print(f"  [ath-warn] {ticker}: Near ATH ({hi_ratio:.2%}) with high beta ({beta_val:.2f})")
                metric_lbl = f"{metric_lbl} ⚠️ATH" if metric_lbl else "⚠️ATH"

            # Fundamentals
            trailing_pe = s.get('pe')
            pb_ratio = s.get('pb')
            
            # EXECUTE WITH EXACT ORDER AS insert_query
            cursor.execute(insert_query, (
                stock_type,         # 1. type
                ticker,             # 2. ticker
                name,               # 3. company_name
                price,              # 4. current_price
                gps,                # 5. gps_score
                json.dumps(gps_breakdown), # 6. gps_breakdown
                classification,     # 7. classification
                upside,             # 8. analyst_upside_pct
                rev_growth,         # 9. revenue_growth_yoy
                margin,             # 10. gross_margin_pct
                rd_pct,             # 11. rd_spend_pct
                market_cap_m,       # 12. market_cap_m
                0,                  # 13. mention_count
                s.get('discovery_source') or 'v2_engine',  # 14. discovery_source ('v2_engine' | 'analyst_consensus' | 'trending_48h')
                s.get('tradingSignal'), # 15. trading_signal
                s.get('tradingSignalScore'), # 16. trading_signal_score
                None,               # 17. upcoming_earnings
                json.dumps(pred_input), # 18. prediction_input
                trailing_pe,        # 19. trailing_pe
                pb_ratio,           # 20. price_to_book
                metric_val,         # 21. metric_value
                metric_lbl,         # 22. metric_label
                today               # 23. snapshot_date
            ))

            # 5. Ensure stock exists in 'stocks' table and persist GPS score for ALL
            #    qualifying stocks (those that passed the ML gate and volatility gate above).
            stock_id = upsert_stock_with_search_fields(
                cursor,
                ticker,
                name,
                price,
                s.get('marketCap'),
                s.get('sector'),
                s.get('industry'),
            )

            # GPS score upsert — always, not gated on dashboard threshold
            cursor.execute(
                "SELECT gps_score FROM stock_gps_scores WHERE stock_id = %s", (stock_id,)
            )
            existing_row = cursor.fetchone()
            existing_gps = float(existing_row[0]) if existing_row and existing_row[0] is not None else None
            gps_changed = existing_gps is None or round(existing_gps, 1) != round(float(gps), 1)

            if gps_changed:
                cursor.execute("""
                    INSERT INTO stock_gps_scores (stock_id, as_of, gps_score, gps_breakdown, source)
                    VALUES (%s, NOW(), %s, %s, 'deepmoney_sync')
                    ON DUPLICATE KEY UPDATE
                        as_of         = VALUES(as_of),
                        gps_score     = VALUES(gps_score),
                        gps_breakdown = VALUES(gps_breakdown),
                        source        = VALUES(source)
                """, (stock_id, gps, json.dumps(gps_breakdown)))
                counters["gps_updated"] += 1
                print(f"    - GPS updated: {existing_gps} → {round(float(gps), 1)}")
            else:
                counters["gps_unchanged"] += 1
                print(f"    - GPS unchanged ({round(float(gps), 1)}), skipping write")

            # 5b. Dashboard qualification: gated on the MLP confidence floor
            # (from the algorithm preset) and the 1-month prediction floor.
            # GPS-based dashboard gating has been retired.
            conf_score_for_dash = pred_input.get('confidence_score_1m')
            if conf_score_for_dash is None:
                conf_score_for_dash = pred_input.get('confidence_score') or 0
            if conf_score_for_dash >= mlp_confidence_floor and predicted_change_pct >= pred_threshold:
                counters["dashboard_qualified"] += 1
                print(f"    - Qualifying stock found for Dashboard: {ticker} (CS: {conf_score_for_dash}, Pred: {predicted_change_pct}%)")
                qualifying_stock_ids.add(stock_id)
                qualifying_stocks_details.append({
                    'ticker': ticker,
                    'gps': float(gps) if gps is not None else 0.0,
                    'cs': float(conf_score_for_dash),
                    'pred_pct': float(predicted_change_pct),
                    'source': s.get('discovery_source') or 'v2_engine',
                })

                # Pull the raw nullable values from pred_input — the existing
                # `predicted_change_pct` / `conf_score` locals above were coerced
                # to 0 for the gate checks, so they can't be used for persistence.
                # The deepmoney route emits both the generic key and the _1m key;
                # prefer the explicit _1m, fall back to the generic.
                change_pct_1m = pred_input.get('predicted_change_pct_1m')
                if change_pct_1m is None:
                    change_pct_1m = pred_input.get('predicted_change_pct')
                conf_score_1m = pred_input.get('confidence_score_1m')
                if conf_score_1m is None:
                    conf_score_1m = pred_input.get('confidence_score')

                # Add prediction for all active users
                for user_id in active_user_ids:
                    # GPS columns removed from user_stock_predictions — now in stock_gps_scores.
                    # predicted_change_pct_1m + confidence_score_1m are persisted so the
                    # dashboard's adjustGpsForHorizon uses the model's actual horizon
                    # output instead of a price-derived approximation.
                    cursor.execute("""
                        INSERT INTO user_stock_predictions
                        (user_id, stock_id, predicted_price_1m,
                         predicted_change_pct_1m, confidence_score_1m, last_requested_at)
                        VALUES (%s, %s, %s, %s, %s, NOW())
                        ON DUPLICATE KEY UPDATE
                        predicted_price_1m      = VALUES(predicted_price_1m),
                        predicted_change_pct_1m = VALUES(predicted_change_pct_1m),
                        confidence_score_1m     = VALUES(confidence_score_1m),
                        last_requested_at       = VALUES(last_requested_at)
                    """, (user_id, stock_id, predicted_price_1m, change_pct_1m, conf_score_1m))

                    # Add to user_stocks as unconfirmed if not already a purchased position
                    cursor.execute("""
                        INSERT INTO user_stocks
                        (user_id, stock_id, is_purchased, user_confirmed, is_active)
                        VALUES (%s, %s, 0, 0, 1)
                        ON DUPLICATE KEY UPDATE
                        user_confirmed = IF(is_purchased = 0, 0, user_confirmed),
                        is_active = IF(is_purchased = 0, 1, is_active)
                    """, (user_id, stock_id))

        # 6. Fetch surfaced ETF holdings via the shared /holdings endpoint
        # The prediction call above already ran scoreETFHoldings + populated etf_holding_scores.
        # We now read those cached scores back through the same endpoint the UI uses.
        hot_etfs = data.get('hot_etfs', [])
        counters["hot_etfs"] = len(hot_etfs)
        print(f"Fetching ETF holdings for {len(hot_etfs)} hot ETF(s) via /api/stock_data/[ticker]/holdings...")

        etf_holding_rs_query = """
        INSERT INTO recommended_stocks (
            type, parent_etf_ticker, holding_percent, ticker, company_name,
            gps_score, gps_breakdown, bearish_signal,
            classification, metric_value, metric_label,
            discovery_source, prediction_input, snapshot_date
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """

        holdings_written = 0
        for etf in hot_etfs:
            etf_ticker = etf.get('ticker')
            if not etf_ticker:
                continue
            try:
                holdings_resp = requests.get(
                    f"{INTERNAL_API_URL}/api/stock_data/{etf_ticker}/holdings",
                    headers={"x-api-key": INTERNAL_SECRET},
                    timeout=30,
                )
                holdings_resp.raise_for_status()
                holdings_json = holdings_resp.json()
            except Exception as e:
                print(f"  Warning: failed to fetch holdings for {etf_ticker}: {e}")
                continue

            for h in holdings_json.get('holdings', []):
                if not h.get('surfaced'):
                    continue

                ticker        = h.get('ticker')
                gps           = h.get('gps_score', 0) or 0
                gps_breakdown = h.get('gps_breakdown') or {}
                score_source  = h.get('score_source', 'cached')
                holding_pct   = h.get('holdingPercent', 0)
                company_name  = h.get('companyName') or ticker

                print(f"  > ETF holding: {ticker} (parent: {etf_ticker}, GPS: {gps})")

                pred_input_json = json.dumps({'score_source': score_source})

                cursor.execute(etf_holding_rs_query, (
                    'etf_holding',                  # type
                    etf_ticker,                     # parent_etf_ticker
                    holding_pct,                    # holding_percent
                    ticker,                         # ticker
                    company_name,                   # company_name
                    gps,                            # gps_score
                    json.dumps(gps_breakdown),      # gps_breakdown
                    0,                              # bearish_signal (surfaced = non-bearish)
                    'ETF Holding',                  # classification
                    gps,                            # metric_value
                    score_source,                   # metric_label
                    f"etf_holdings/{etf_ticker}",   # discovery_source
                    pred_input_json,                # prediction_input
                    today,                          # snapshot_date
                ))
                holdings_written += 1

        counters["etf_holdings_written"] = holdings_written
        print(f"  ETF holdings persisted: {holdings_written}")

        # Off-market movers: check the full processed universe for pre/post
        # market moves above OFF_MARKET_MIN_CHANGE_PCT and write to DB.
        sync_off_market_movers(cursor, all_processed_tickers, today, counters)

        # Dashboard tenure bookkeeping. Reconciles the just-written hot_stocks
        # set against the prior-sync snapshot captured before DELETE, then
        # updates dashboard_tenure so /api/dashboard/deepmoney-picks can
        # demote names that have overstayed their welcome.
        cursor.execute(
            "SELECT ticker FROM recommended_stocks WHERE snapshot_date = %s AND type = 'hot_stocks'",
            (today,),
        )
        current_dashboard_tickers = {row[0] for row in cursor.fetchall()}

        returning_tickers = current_dashboard_tickers & prior_dashboard_tickers
        new_arrivals      = current_dashboard_tickers - prior_dashboard_tickers
        evicted_tickers   = prior_dashboard_tickers   - current_dashboard_tickers

        # Returning: bump consecutive_days only if we're on a new calendar day
        # (avoids double-counting when the sync gets re-run twice in one day).
        for tk in returning_tickers:
            cursor.execute("""
                UPDATE dashboard_tenure
                   SET consecutive_days = consecutive_days + CASE WHEN last_seen_at < %s THEN 1 ELSE 0 END,
                       last_seen_at     = %s,
                       evicted_at       = NULL
                 WHERE ticker = %s
            """, (today, today, tk))

        # New arrivals: either brand-new tickers (INSERT) or ones returning
        # from an earlier eviction (the row already exists — reset the streak
        # so tenure starts counting from today's re-entry, not the old stint).
        for tk in new_arrivals:
            cursor.execute("""
                INSERT INTO dashboard_tenure
                    (ticker, first_seen_at, last_seen_at, consecutive_days)
                VALUES (%s, %s, %s, 1)
                ON DUPLICATE KEY UPDATE
                    first_seen_at    = VALUES(first_seen_at),
                    last_seen_at     = VALUES(last_seen_at),
                    consecutive_days = 1,
                    evicted_at       = NULL
            """, (tk, today, today))

        # Evicted: stamp the drop-out time so the API cooldown filter can hold
        # them out for a few syncs before they're eligible to return.
        for tk in evicted_tickers:
            cursor.execute("""
                UPDATE dashboard_tenure
                   SET evicted_at = NOW()
                 WHERE ticker = %s AND evicted_at IS NULL
            """, (tk,))

        counters["dashboard_tenure_new"]       = len(new_arrivals)
        counters["dashboard_tenure_returning"] = len(returning_tickers)
        counters["dashboard_tenure_evicted"]   = len(evicted_tickers)
        print(
            f"Dashboard tenure: {len(new_arrivals)} new, "
            f"{len(returning_tickers)} continuing, "
            f"{len(evicted_tickers)} evicted."
        )

        # Post-sync cleanup: remove discovery entries for stocks that didn't qualify this run.
        # This replaces the old pre-clear approach and is exact — only stocks not in
        # today's qualifying set are removed, regardless of how they got into the DB.
        print("Cleaning up stale discovery entries from previous runs...")
        if qualifying_stock_ids:
            stale_ph = ','.join(['%s'] * len(qualifying_stock_ids))
            cursor.execute(f"""
                SELECT DISTINCT stock_id FROM user_stocks
                WHERE is_active = 1 AND user_confirmed = 0
                AND stock_id NOT IN ({stale_ph})
            """, list(qualifying_stock_ids))
        else:
            cursor.execute("""
                SELECT DISTINCT stock_id FROM user_stocks
                WHERE is_active = 1 AND user_confirmed = 0
            """)
        stale_ids = [row[0] for row in cursor.fetchall()]
        if stale_ids:
            stale_placeholders = ','.join(['%s'] * len(stale_ids))
            cursor.execute(f"DELETE FROM user_stock_predictions WHERE stock_id IN ({stale_placeholders})", stale_ids)
            cursor.execute(f"DELETE FROM user_stocks WHERE is_active = 1 AND user_confirmed = 0 AND stock_id IN ({stale_placeholders})", stale_ids)
            counters["stale_cleaned"] = len(stale_ids)
            print(f"  Removed {len(stale_ids)} stale discovery stock(s) not in today's qualifying set.")
        else:
            print("  No stale entries found.")

        conn.commit()
        print(f"[{datetime.now()}] Sync completed successfully.")

    except Exception as e:
        print(f"Error during database operations: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        try:
            cursor.close()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        _print_run_summary(
            counters,
            meta_snapshot,
            algorithm_level,
            mlp_confidence_floor,
            vol_gate_floor,
            run_start,
            qualifying_stocks_details,
        )


def _fmt_int(n) -> str:
    """Right-aligned integer formatter for the summary table."""
    try:
        return f"{int(n):>6,}"
    except (TypeError, ValueError):
        return f"{'--':>6}"


def _fmt_duration(elapsed_sec: float) -> str:
    if elapsed_sec < 60:
        return f"{elapsed_sec:.1f}s"
    mins, secs = divmod(elapsed_sec, 60)
    if mins < 60:
        return f"{int(mins)}m {int(secs)}s"
    hrs, mins = divmod(mins, 60)
    return f"{int(hrs)}h {int(mins)}m {int(secs)}s"


def _print_run_summary(
    counters: dict,
    meta: dict,
    algorithm_level: float,
    mlp_floor: float,
    vol_floor: float,
    run_start: float,
    qualifying_stocks: list[dict] | None = None,
) -> None:
    """Print a structured funnel summary at the end of the run.

    Always called from the finally block, so it prints even when an exception
    short-circuits the sync. Numbers from a partial run are still useful for
    debugging — missing counters just stay at zero.
    """
    debug = (meta or {}).get('debug', {}) or {}
    algorithm = (meta or {}).get('algorithm', {}) or {}
    elapsed = time.time() - run_start

    print()
    print("=" * 70)
    print("  DEEPMONEY SYNC SUMMARY")
    print("=" * 70)

    # ── Algorithm preset ────────────────────────────────────────────────────
    keep_pct = algorithm.get('rankerKeepPct')
    keep_pct_str = f"{float(keep_pct):.4g}" if keep_pct is not None else "?"
    print(f"  ALGORITHM LEVEL: {algorithm_level:g}  "
          f"(rankerKeepPct={keep_pct_str}, "
          f"mlpConfidenceFloor={mlp_floor:g}, volGateFloor={vol_floor:g})")

    # ── Discovery → ranker funnel (from API meta.debug) ────────────────────
    print()
    print("  DISCOVERY → RANKER FUNNEL")
    print(f"    Total tickers discovered:        {_fmt_int(meta.get('totalDiscovered'))}")
    print(f"    Popular-ETF holdings merged:     {_fmt_int(meta.get('etfPopularHoldingsCount'))}")
    print(f"    Rejected at enrichment:          {_fmt_int(debug.get('rejectedEnrichment'))}")
    print(f"    Rejected on signal score:        {_fmt_int(debug.get('rejectedSignalScore'))}")
    print(f"    Rejected on history (<30 days):  {_fmt_int(debug.get('rejectedHistory'))}")
    print(f"    Passed to analyzer:              {_fmt_int(debug.get('passedToAnalyzer'))}")
    print(f"    Rejected by ranker:              {_fmt_int(debug.get('rejectedByRanker'))}")
    ranker_survivors = debug.get('rankerSurvivorCount')
    ranker_fellthrough = debug.get('rankerFellThrough')
    if ranker_survivors is not None:
        tag = "  [FELL THROUGH — ranker inactive]" if ranker_fellthrough else ""
        print(f"    Ranker survivors → light model:  {_fmt_int(ranker_survivors)}{tag}")
    lm_passed   = debug.get('lightModelPassed')
    lm_filtered = debug.get('lightModelFiltered')
    if lm_passed is not None:
        print(f"    Light model passed:              {_fmt_int(lm_passed)}")
        print(f"    Light model filtered:            {_fmt_int(lm_filtered)}")
    print(f"    Surfaced by API:                 {_fmt_int(counters.get('stocks_in_api_resp'))}")

    # ── Analyst-grade override lane (A- or better bypasses ranker) ────────────
    analyst_surfaced = debug.get('analystConsensusSurfaced')
    if analyst_surfaced is not None:
        print()
        print("  ANALYST-GRADE OVERRIDE LANE  (grade >= A-, composite >= 82)")
        print(f"    Surfaced via grade override:     {_fmt_int(analyst_surfaced)}")

    # ── Trending-48h override lane ─────────────────────────────────────────
    trending_merged   = debug.get('trendingTickerCount')
    trending_surfaced = debug.get('trending48hSurfaced')
    if trending_merged is not None:
        print()
        print("  TRENDING-48H OVERRIDE LANE")
        print(f"    Trending tickers merged:         {_fmt_int(trending_merged)}")
        print(f"    Surfaced via override lane:      {_fmt_int(trending_surfaced)}")

    # ── Unusual-options override lane ─────────────────────────────────────────
    uo_injected = debug.get('unusualOptionsInjected')
    uo_surfaced = debug.get('unusualOptionsSurfaced')
    if uo_injected is not None:
        print()
        print("  UNUSUAL-OPTIONS OVERRIDE LANE")
        print(f"    Tickers flagged (call-volume/OI):  {_fmt_int(uo_injected)}")
        print(f"    Surfaced via override lane:        {_fmt_int(uo_surfaced)}")

    # ── Insider-cluster override lane ─────────────────────────────────────────
    ic_injected = debug.get('insiderClusterInjected')
    ic_surfaced = debug.get('insiderClusterSurfaced')
    if ic_injected is not None:
        print()
        print("  INSIDER-CLUSTER OVERRIDE LANE")
        print(f"    Tickers flagged (cluster buy):     {_fmt_int(ic_injected)}")
        print(f"    Surfaced via override lane:        {_fmt_int(ic_surfaced)}")

    # ── Revision-momentum override lane ───────────────────────────────────────
    rm_injected = debug.get('revisionMomentumInjected')
    rm_surfaced = debug.get('revisionMomentumSurfaced')
    if rm_injected is not None:
        print()
        print("  REVISION-MOMENTUM OVERRIDE LANE")
        print(f"    Tickers flagged (net >=+3 in 10d): {_fmt_int(rm_injected)}")
        print(f"    Surfaced via override lane:        {_fmt_int(rm_surfaced)}")

    # ── Short-squeeze override lane ───────────────────────────────────────────
    ss_injected = debug.get('shortSqueezeInjected')
    ss_surfaced = debug.get('shortSqueezeSurfaced')
    if ss_injected is not None:
        print()
        print("  SHORT-SQUEEZE OVERRIDE LANE")
        print(f"    Tickers flagged (setup criteria):  {_fmt_int(ss_injected)}")
        print(f"    Surfaced via override lane:        {_fmt_int(ss_surfaced)}")

    # ── Volume-breakout override lane ─────────────────────────────────────────
    vb_injected = debug.get('volumeBreakoutInjected')
    vb_surfaced = debug.get('volumeBreakoutSurfaced')
    if vb_injected is not None:
        print()
        print("  VOLUME-BREAKOUT OVERRIDE LANE")
        print(f"    Tickers flagged (2.5xvol+20dHi):  {_fmt_int(vb_injected)}")
        print(f"    Surfaced via override lane:        {_fmt_int(vb_surfaced)}")

    # ── SEC 8-K event override lane ───────────────────────────────────────────
    edgar_lane_injected = debug.get('edgarLaneInjected')
    edgar_lane_surfaced = debug.get('edgarLaneSurfaced')
    edgar_backfill_seen = counters.get('edgar_backfill_seen') or 0
    edgar_backfill_added = counters.get('edgar_backfill_added') or 0
    if edgar_lane_injected is not None or edgar_backfill_seen:
        print()
        print("  SEC 8-K EVENT LANE")
        print(f"    High-signal filings injected:     {_fmt_int(edgar_lane_injected)}")
        print(f"    Surfaced via override lane:        {_fmt_int(edgar_lane_surfaced)}")
        if edgar_backfill_seen:
            print(f"    8-K tickers backfilled to stocks:  {_fmt_int(edgar_backfill_added)}/{_fmt_int(edgar_backfill_seen)}")

    # ── Ollama NER pass (feature-flagged; absent when OLLAMA_ENABLED=false) ──
    ollama_pass = (meta or {}).get('ollamaPass')
    preflight = counters.get('ollama_preflight', 'disabled')
    if ollama_pass or preflight != 'disabled':
        print()
        print("  OLLAMA NER PASS")
        print(f"    Pre-flight (host):               {preflight}")
        if ollama_pass:
            reached = "yes" if ollama_pass.get('reachable') else "no"
            print(f"    Server reachable from API:       {reached}")
            print(f"    Articles scanned:                {_fmt_int(ollama_pass.get('articlesScanned'))}")
            print(f"    Companies extracted:             {_fmt_int(ollama_pass.get('companiesFound'))}")
            print(f"    Industries extracted:            {_fmt_int(ollama_pass.get('industriesFound'))}")
            print(f"    Tickers resolved (merged):       {_fmt_int(ollama_pass.get('tickersResolved'))}")
            rejected = ollama_pass.get('tickersRejected')
            if rejected is not None:
                print(f"    Tickers rejected by verifier:    {_fmt_int(rejected)}")
            # Item 5 — event-type classification. Absent from older API
            # responses that predate the classifier.
            dominant = ollama_pass.get('dominantEventByTicker') or {}
            if dominant:
                # Count how many tickers got each event type. Sorted by count
                # desc so the loud events float to the top of the run summary.
                by_type: dict = {}
                for et in dominant.values():
                    by_type[et] = by_type.get(et, 0) + 1
                top = sorted(by_type.items(), key=lambda kv: (-kv[1], kv[0]))
                summary = ', '.join(f"{et}={n}" for et, n in top)
                print(f"    Event-type tags (n={len(dominant)}):    {summary}")
        else:
            print("    (API did not return meta.ollamaPass — feature flag off server-side)")

    # ── Sector-leader override lane (powers /search/industry/[sector] GPS) ──
    sl_injected      = debug.get('sectorLeadersInjected')
    sl_skipped_fresh = debug.get('sectorLeadersSkippedFresh')
    sl_computed      = debug.get('sectorLeadersComputed')
    sl_surfaced      = debug.get('sectorLeadersSurfaced')
    if sl_injected is not None:
        print()
        print("  SECTOR-LEADER OVERRIDE LANE")
        print(f"    Injected (top-25 per sector):    {_fmt_int(sl_injected)}")
        print(f"    Skipped (GPS fresh <12h):        {_fmt_int(sl_skipped_fresh)}")
        print(f"    Ran MC + GPS this pass:          {_fmt_int(sl_computed)}")
        print(f"    Surfaced in API response:        {_fmt_int(sl_surfaced)}")

    # ── Earnings-calendar backfill (NASDAQ) ─────────────────────────────────
    ec_seen  = counters.get('earnings_cal_seen') or 0
    ec_added = counters.get('earnings_cal_added') or 0
    if ec_seen:
        print()
        print("  EARNINGS-CALENDAR BACKFILL")
        print(f"    Tickers from NASDAQ calendar:    {_fmt_int(ec_seen)}")
        print(f"    Newly added to `stocks`:         {_fmt_int(ec_added)}")
        print(f"    Already present:                 {_fmt_int(ec_seen - ec_added)}")

    # ── Local gating (this script's filters on top of API output) ───────────
    print()
    print("  LOCAL GATING")
    print(f"    Price ceiling (>${PRICE_CEILING_USD:,}):"
          f"{' ':>5}{_fmt_int(counters.get('price_ceiling_rejected'))} rejected")
    print(f"    MLP confidence floor ({mlp_floor}):"
          f"{' ':>8}{_fmt_int(counters.get('vol_gate_rejected'))} rejected (combined w/ vol gate)")
    print(f"    Written to recommended_stocks:   {_fmt_int(counters.get('stocks_written'))}")
    print(f"    Dashboard qualified (CS≥{mlp_floor}):"
          f"{' ':>6}{_fmt_int(counters.get('dashboard_qualified'))} qualified")
    if counters.get('ath_warnings'):
        print(f"    Near-ATH high-beta warnings:     {_fmt_int(counters.get('ath_warnings'))}")

    # ── Score-history writes ────────────────────────────────────────────────
    print()
    print("  GPS HISTORY")
    print(f"    Scores updated:                  {_fmt_int(counters.get('gps_updated'))}")
    print(f"    Scores unchanged (skipped):      {_fmt_int(counters.get('gps_unchanged'))}")

    # ── ETF holdings + cleanup ──────────────────────────────────────────────
    print()
    print("  ETF HOLDINGS & CLEANUP")
    print(f"    Hot ETFs surfaced:               {_fmt_int(counters.get('hot_etfs'))}")
    print(f"    ETF holdings written:            {_fmt_int(counters.get('etf_holdings_written'))}")
    print(f"    Off-market movers written:       {_fmt_int(counters.get('off_market_movers'))}")
    print(f"    Stale discovery rows cleaned:    {_fmt_int(counters.get('stale_cleaned'))}")

    # ── Users + timing ──────────────────────────────────────────────────────
    print()
    print("  RUN")
    print(f"    Approved users notified:         {_fmt_int(counters.get('active_users'))}")
    print(f"    Sync duration:                   {_fmt_duration(elapsed):>6}")

    # ── Per-stock detail of what actually surfaced to the dashboard ────────
    # Sorted by GPS desc so the strongest picks are at the top — matches the
    # dashboard sort order (BR-8.6). Source column distinguishes ranker
    # survivors (v2_engine) from analyst-override picks (analyst_consensus).
    if qualifying_stocks:
        print()
        print(f"  DASHBOARD-QUALIFIED STOCKS ({len(qualifying_stocks)})")
        print(f"    {'TICKER':<10} {'GPS':>6}  {'CS':>5}  {'PRED':>7}  SOURCE")
        print(f"    {'-'*10} {'-'*6}  {'-'*5}  {'-'*7}  {'-'*17}")
        for q in sorted(qualifying_stocks, key=lambda x: x.get('gps', 0), reverse=True):
            ticker   = str(q.get('ticker', '?'))[:10]
            gps      = q.get('gps', 0)
            cs       = q.get('cs', 0)
            pred_pct = q.get('pred_pct', 0)
            source   = str(q.get('source', 'v2_engine'))[:17]
            print(f"    {ticker:<10} {gps:>6.1f}  {cs:>5.0f}  {pred_pct:>+6.2f}%  {source}")

    # ── Phase-4 retrain coverage gate ──────────────────────────────────────
    # Non-blocking: import the check inline so a DB hiccup doesn't abort the
    # summary.  Pass --fire only when you're ready to let it auto-trigger.
    try:
        import importlib.util, types
        _spec = importlib.util.spec_from_file_location(
            "check_retrain_coverage",
            str(Path(__file__).resolve().parent / "check_retrain_coverage.py"),
        )
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)  # type: ignore[union-attr]

        import logging as _logging
        _log = _logging.getLogger("deepmoney_sync.coverage")
        _stats = _mod.query_coverage(_log)
        if _stats:
            _state = _mod.load_state()
            _mod.print_coverage_summary(_stats, _state)
    except Exception as _cov_err:
        print(f"  [coverage check skipped: {_cov_err}]")

    print("=" * 70)

if __name__ == "__main__":
    sync_deepmoney()
