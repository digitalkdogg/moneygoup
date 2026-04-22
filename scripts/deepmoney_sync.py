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
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
INTERNAL_SECRET = os.getenv('DEEPMONEY_INTERNAL_SECRET')
NEXTAUTH_URL = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
API_URL = f"{NEXTAUTH_URL}/api/prediction/deepmoney?refresh=true"
WB_API_URL = f"{NEXTAUTH_URL}/api/worldbank"

# Global cache for market indices
_indices_cache = None

def get_market_indices(headers: dict) -> dict | None:
    """Fetch major indices from the internal API with local caching."""
    global _indices_cache
    if _indices_cache is not None:
        return _indices_cache
    
    url = f"{NEXTAUTH_URL}/api/market/indices"
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

        # 3.5 Fetch active users (login in past 7 days)
        print("Fetching active users...")
        cursor.execute("SELECT id FROM users WHERE last_login >= DATE_SUB(NOW(), INTERVAL 7 DAY)")
        active_user_ids = [row[0] for row in cursor.fetchall()]
        print(f"Found {len(active_user_ids)} active users.")

        # 4. Process Stocks from (stocks array)
        stocks = data.get('stocks', [])
        print(f"Processing {len(stocks)} hot stocks...")
        
        # COLUMN ORDER MUST MATCH VALUES IN CURSOR.EXECUTE
        insert_query = """
        INSERT INTO recommended_stocks
        (
            type, ticker, company_name, current_price, gps_score, classification,
            analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct,
            market_cap_m, mention_count, discovery_source, trading_signal,
            trading_signal_score, upcoming_earnings, prediction_input,
            trailing_pe, price_to_book, metric_value, metric_label, snapshot_date
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        
        for s in stocks:
            print(f"  > {s['ticker']}")
            
            # Map V2 fields to DB variables
            stock_type = "hot_stocks"
            ticker = s.get('ticker')
            name = s.get('name')
            price = s.get('price')
            gps = s.get('gps_score', 0)
            classification = s.get('sector', 'Unknown') # sector -> classification
            
            # Scaling
            upside = (s.get('analystUpside') or 0) * 100
            rev_growth = (s.get('revenueGrowth') or 0) * 100
            margin = (s.get('grossMargins') or 0) * 100
            
            total_rev = s.get('totalRevenue') or 1
            rd_spend = s.get('researchDevelopment') or 0
            rd_pct = (rd_spend / total_rev) * 100
            
            market_cap_m = (s.get('marketCap') or 0) / 1e6
            
            # Prediction metrics (Extraction from prediction_input)
            pred_input = s.get('prediction_input') or {}
            metric_val = pred_input.get('predicted_change_pct') # predicted_change_pct -> metric_value
            metric_lbl = f"CS: {pred_input.get('confidence_score')}" if pred_input.get('confidence_score') is not None else None # confidence_score -> metric_label
            
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
                classification,     # 6. classification
                upside,             # 7. analyst_upside_pct
                rev_growth,         # 8. revenue_growth_yoy
                margin,             # 9. gross_margin_pct
                rd_pct,             # 10. rd_spend_pct
                market_cap_m,       # 11. market_cap_m
                0,                  # 12. mention_count
                'v2_engine',        # 13. discovery_source
                s.get('tradingSignal'), # 14. trading_signal
                s.get('tradingSignalScore'), # 15. trading_signal_score
                None,               # 16. upcoming_earnings
                json.dumps(pred_input), # 17. prediction_input
                trailing_pe,        # 18. trailing_pe
                pb_ratio,           # 19. price_to_book
                metric_val,         # 20. metric_value
                metric_lbl,         # 21. metric_label
                today               # 22. snapshot_date
            ))

            # 5. Check qualification for user_stock_predictions
            # Thresholds from environment or defaults
            pred_env = os.getenv('DEEPMONEY_RECOMMENDATION_PREDICTION_VALUE')
            pred_threshold = float(pred_env) if pred_env else 5.0
            
            gps_env = os.getenv('DEEPMONEY_RECOMMENDATION_GPS_VALUE')
            gps_threshold = float(gps_env) if gps_env else 6.0
            
            predicted_change_pct = pred_input.get('predicted_change_pct', 0)
            predicted_price_1m = pred_input.get('predicted_price_1m')

            if predicted_change_pct > pred_threshold and gps > gps_threshold and predicted_price_1m is not None:
                print(f"    - Qualifying stock found: {ticker} (GPS: {gps}, Pred: {predicted_change_pct}%)")
                
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

                # b. Add prediction for all active users
                for user_id in active_user_ids:
                    # Update or insert prediction
                    cursor.execute("""
                        INSERT INTO user_stock_predictions 
                        (user_id, stock_id, predicted_price_1m, last_requested_at)
                        VALUES (%s, %s, %s, NOW())
                        ON DUPLICATE KEY UPDATE 
                        predicted_price_1m = VALUES(predicted_price_1m),
                        last_requested_at = VALUES(last_requested_at)
                    """, (user_id, stock_id, predicted_price_1m))

                    # Add to user_stocks as unconfirmed if not already a purchased position
                    cursor.execute("""
                        INSERT INTO user_stocks 
                        (user_id, stock_id, is_purchased, user_confirmed)
                        VALUES (%s, %s, 0, 0)
                        ON DUPLICATE KEY UPDATE 
                        user_confirmed = IF(is_purchased = 0, 0, user_confirmed)
                    """, (user_id, stock_id))

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
