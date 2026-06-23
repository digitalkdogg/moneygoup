import json
import os
import time
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv
from prediction_recorder import record_prediction

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
# Scripts always run on the same machine as Next.js, so call localhost directly
# to bypass nginx and its 60s proxy timeout. The deepmoney route can take 2+ min.
INTERNAL_API_URL = 'http://localhost:3001'
API_URL = f"{INTERNAL_API_URL}/api/prediction/deepmoney?refresh=true"
WB_API_URL = f"{INTERNAL_API_URL}/api/worldbank"

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

def sync_deepmoney():
    print(f"[{datetime.now()}] Starting DeepMoney sync...")

    # ── Run-level counters for the end-of-run summary ─────────────────────
    # Initialized up here so they're always defined, even when an exception
    # short-circuits the work before they'd otherwise be set.
    run_start = time.time()
    counters = {
        "vol_gate_rejected":     0,   # MLP confidence-vs-beta gate
        "stocks_written":        0,   # rows inserted into recommended_stocks
        "gps_updated":           0,   # stock_gps_scores rows updated (score changed)
        "gps_unchanged":         0,   # stock_gps_scores rows skipped (same score)
        "dashboard_qualified":   0,   # stocks meeting MLP-confidence dashboard gate
        "ath_warnings":          0,   # high-beta near-ATH stocks flagged
        "etf_holdings_written":  0,   # rows inserted from ETF holdings pass
        "stale_cleaned":         0,   # discovery rows removed in cleanup pass
        "active_users":          0,
        "hot_etfs":              0,
        "stocks_in_api_resp":    0,
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
            print(f"  [debug] Final Filtered Count: {debug.get('filteredCount')}")
            print(f"  [debug] ETF Holdings Surfaced: {meta.get('etfHoldingsSurfacedCount')}")
            print(f"  [debug] Popular-ETF Holdings Merged: {meta.get('etfPopularHoldingsCount')}")
            print(f"  [debug] Trending 48h Merged: {debug.get('trendingTickerCount')}")
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

        # 3. Clear existing recommendation data
        print("Clearing existing recommendation data...")
        cursor.execute("DELETE FROM recommended_stocks")

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

        # 3.5 Fetch all approved users (so new users see recommendations on first login)
        print("Fetching approved users...")
        cursor.execute("SELECT id FROM users WHERE approval_status = 'approved'")
        active_user_ids = [row[0] for row in cursor.fetchall()]
        counters["active_users"] = len(active_user_ids)
        print(f"Found {len(active_user_ids)} approved users.")

        # 4. Process Stocks from (stocks array)
        stocks = data.get('stocks', [])
        counters["stocks_in_api_resp"] = len(stocks)
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
        
        for s in stocks:
            ticker = s.get('ticker')
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
            predicted_price_1w = pred_input.get('predicted_price_1w')
            predicted_price_1m = pred_input.get('predicted_price_1m')
            if predicted_price_1m is None:
                predicted_price_1m = pred_input.get('predicted_price')
            predicted_price_6m = pred_input.get('predicted_price_6m')
            predicted_price_1y = pred_input.get('predicted_price_1y')

            # Record to analytics prediction_records table BEFORE the vol-gate
            # check. Every ranker survivor has a real per-horizon prediction;
            # recording the rejects too lets us audit how well the floor was
            # calibrated (was the model right to be confident?).
            if price and (predicted_price_1w or predicted_price_1m or predicted_price_6m or predicted_price_1y):
                record_prediction(
                    symbol=ticker,
                    price_at_prediction=price,
                    predicted_price_1w=predicted_price_1w,
                    predicted_price_1m=predicted_price_1m,
                    predicted_price_6m=predicted_price_6m,
                    predicted_price_1y=predicted_price_1y,
                )

            # 4.1 (removed) Per-stock GPS gate — the LightGBM ranker already
            #     filtered the universe server-side via algorithm.rankerKeepPct;
            #     every stock arriving here is a ranker survivor.

            # Sector-leader stocks bypass the vol-gate and skip both the
            # recommended_stocks insert and the dashboard gate. They're here
            # solely to refresh stock_gps_scores so /search/industry/[sector]
            # can render a real GPS column. Jump straight to the stocks/GPS
            # upsert block.
            is_sector_leader = s.get('discovery_source') == 'sector_leader'

            # 4.2 Confidence-vs-beta gate driven by the algorithm preset.
            # High-beta stocks (beta > 2.5) face the stricter volGateFloor;
            # everything else faces the mlpConfidenceFloor. The skip tag in
            # the log distinguishes which floor fired so we can audit runs.
            conf_score = pred_input.get('confidence_score') or pred_input.get('confidence_score_1m') or 0
            beta_val = s.get('beta') or 1.0
            high_beta = beta_val > 2.5
            confidence_floor = vol_gate_floor if high_beta else mlp_confidence_floor
            floor_label = "vol-floor" if high_beta else "mlp-floor"
            if conf_score < confidence_floor and not is_sector_leader:
                print(f"  [vol-gate] SKIP {ticker} ({floor_label}): CS {conf_score} < floor {confidence_floor} (beta {beta_val:.2f})")
                counters["vol_gate_rejected"] += 1
                continue

            if is_sector_leader:
                # Fast-path: refresh stocks + stock_gps_scores only, skip
                # recommended_stocks insert + dashboard gate.
                cursor.execute("SELECT id FROM stocks WHERE symbol = %s", (ticker,))
                stock_row = cursor.fetchone()
                if stock_row:
                    stock_id = stock_row[0]
                else:
                    print(f"    - [sector-leader] Adding {ticker} to stocks table...")
                    cursor.execute(
                        "INSERT INTO stocks (symbol, company_name, price) VALUES (%s, %s, %s)",
                        (ticker, s.get('name'), s.get('price'))
                    )
                    stock_id = cursor.lastrowid
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
                print(f"  > [sector-leader] {ticker} GPS {round(float(gps), 1)} (pred {predicted_change_pct:+.2f}%, CS {conf_score})")
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
                s.get('discovery_source') or 'v2_engine',  # 14. discovery_source ('v2_engine' | 'analyst_consensus')
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
            cursor.execute("SELECT id FROM stocks WHERE symbol = %s", (ticker,))
            stock_row = cursor.fetchone()
            if stock_row:
                stock_id = stock_row[0]
            else:
                print(f"    - Adding {ticker} to stocks table...")
                cursor.execute(
                    "INSERT INTO stocks (symbol, company_name, price) VALUES (%s, %s, %s)",
                    (ticker, name, price)
                )
                stock_id = cursor.lastrowid

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
    print(f"    Rejected on history (<100 days): {_fmt_int(debug.get('rejectedHistory'))}")
    print(f"    Passed to analyzer:              {_fmt_int(debug.get('passedToAnalyzer'))}")
    print(f"    Rejected by ranker:              {_fmt_int(debug.get('rejectedByRanker'))}")
    print(f"    Surfaced by API:                 {_fmt_int(counters.get('stocks_in_api_resp'))}")

    # ── Sector-leader override lane (powers /search/industry/[sector] GPS) ──
    sl_injected      = debug.get('sectorLeadersInjected')
    sl_skipped_fresh = debug.get('sectorLeadersSkippedFresh')
    sl_computed      = debug.get('sectorLeadersComputed')
    sl_surfaced      = debug.get('sectorLeadersSurfaced')
    if sl_injected is not None:
        print()
        print("  SECTOR-LEADER OVERRIDE LANE")
        print(f"    Injected (top-25 per sector):    {_fmt_int(sl_injected)}")
        print(f"    Skipped (GPS fresh <7d):         {_fmt_int(sl_skipped_fresh)}")
        print(f"    Ran MC + GPS this pass:          {_fmt_int(sl_computed)}")
        print(f"    Surfaced in API response:        {_fmt_int(sl_surfaced)}")

    # ── Local gating (this script's filters on top of API output) ───────────
    print()
    print("  LOCAL GATING")
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

    print("=" * 70)

if __name__ == "__main__":
    sync_deepmoney()
