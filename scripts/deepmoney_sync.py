import json
import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv

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
    
    # ML Validation Gate (Ref: doc/deepmoney_sync_workflow.html)
    # This is the "Gate" that allows a stock to be recorded as a recommendation
    gate_env = os.getenv('DEEPMONEY_GPS_VALUE')
    ml_gate_threshold = float(gate_env) if gate_env else 10.0
    
    # Qualifying Threshold for Dashboard
    # This is the "Gold Standard" that pushes it to user portfolios/dashboards
    rec_env = os.getenv('DEEPMONEY_RECOMMENDATION_GPS_VALUE')
    dashboard_threshold = float(rec_env) if rec_env else 25.0
    
    pred_threshold = 1.5 # Gate: Sequential 1-month ML prediction
    
    print(f"  [config] ML Gate (GPS > {ml_gate_threshold}), Dashboard Threshold (GPS > {dashboard_threshold})")
    print(f"  [config] Prediction Gate (>= {pred_threshold}%)")
    
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
        if debug:
            print(f"  [debug] Enrichment Rejected: {debug.get('rejectedEnrichment')}")
            print(f"  [debug] Signal Score Rejected: {debug.get('rejectedSignalScore')}")
            print(f"  [debug] History Rejected (<100d): {debug.get('rejectedHistory')}")
            print(f"  [debug] Passed to AI Analyzer: {debug.get('passedToAnalyzer')}")
            print(f"  [debug] Rejected by AI (<1.5%): {debug.get('rejectedByAI')}")
            print(f"  [debug] Final Filtered Count: {debug.get('filteredCount')}")
            print(f"  [debug] ETF Holdings Surfaced: {meta.get('etfHoldingsSurfacedCount')}")
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
        print(f"Found {len(active_user_ids)} approved users.")

        # 4. Process Stocks from (stocks array)
        stocks = data.get('stocks', [])
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

            # 4.1 Apply ML Validation Gate (GPS > DEEPMONEY_GPS_VALUE)
            if gps <= ml_gate_threshold:
                # print(f"  [gate] SKIP {ticker}: GPS {gps} <= Gate {ml_gate_threshold}")
                continue

            # 4.2 Volatility-adjusted confidence gate
            conf_score = pred_input.get('confidence_score') or pred_input.get('confidence_score_1m') or 0
            beta_val = s.get('beta') or 1.0
            volatility_gate = conf_score >= 50
            if beta_val > 2.5:
                volatility_gate = conf_score >= 65
            if not volatility_gate:
                print(f"  [vol-gate] SKIP {ticker}: CS {conf_score} insufficient for beta {beta_val:.2f}")
                continue

            print(f"  > {ticker} (GPS: {gps}, Pred: {predicted_change_pct}%)")
            
            # Map V2 fields to DB variables
            stock_type = "hot_stocks"
            name = s.get('name')
            price = s.get('price')
            classification = s.get('sector', 'Unknown')
            
            # Scaling
            upside = (s.get('analystUpside') or 0) * 100
            rev_growth = (s.get('revenueGrowth') or 0) * 100
            margin = (s.get('grossMargins') or 0) * 100
            
            total_rev = s.get('totalRevenue') or 0
            rd_spend = s.get('researchDevelopment') or 0
            rd_pct = min((rd_spend / total_rev) * 100, 999999.99) if total_rev > 0 else 0
            
            market_cap_m = (s.get('marketCap') or 0) / 1e6
            
            predicted_price_1m = pred_input.get('predicted_price_1m')
            if predicted_price_1m is None:
                predicted_price_1m = pred_input.get('predicted_price')

            metric_val = predicted_change_pct
            metric_lbl = f"CS: {pred_input.get('confidence_score')}" if pred_input.get('confidence_score') is not None else None

            # ATH proximity warning flag
            hi_ratio = s.get('hiRatio52w') or 0
            if hi_ratio > 0.97 and beta_val > 2.0:
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
                'v2_engine',        # 14. discovery_source
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

            # 5. Check qualification for user_stock_predictions (GPS > DEEPMONEY_RECOMMENDATION_GPS_VALUE)
            if gps > dashboard_threshold and predicted_change_pct >= pred_threshold:
                print(f"    - Qualifying stock found for Dashboard: {ticker} (GPS: {gps})")
                
                # a. Ensure stock exists in 'stocks' table
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

                qualifying_stock_ids.add(stock_id)

                # Only write canonical GPS score if it changed (DECIMAL(5,1) → compare at 1dp).
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
                    print(f"    - GPS updated: {existing_gps} → {round(float(gps), 1)}")
                else:
                    print(f"    - GPS unchanged ({round(float(gps), 1)}), skipping write")

                # b. Add prediction for all active users
                for user_id in active_user_ids:
                    # GPS columns removed from user_stock_predictions — now in stock_gps_scores.
                    cursor.execute("""
                        INSERT INTO user_stock_predictions
                        (user_id, stock_id, predicted_price_1m, last_requested_at)
                        VALUES (%s, %s, %s, NOW())
                        ON DUPLICATE KEY UPDATE
                        predicted_price_1m = VALUES(predicted_price_1m),
                        last_requested_at  = VALUES(last_requested_at)
                    """, (user_id, stock_id, predicted_price_1m))

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
            print(f"  Removed {len(stale_ids)} stale discovery stock(s) not in today's qualifying set.")
        else:
            print("  No stale entries found.")

        conn.commit()
        print(f"[{datetime.now()}] Sync completed successfully.")
        
    except Exception as e:
        print(f"Error during database operations: {e}")
        conn.rollback()
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    sync_deepmoney()
