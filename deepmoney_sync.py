import json
import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv

# Load environment variables relative to this script's directory,
# not the current working directory of the calling process.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

if os.path.exists(os.path.join(SCRIPT_DIR, '.env.production')):
    load_dotenv(os.path.join(SCRIPT_DIR, '.env.production'))
load_dotenv(os.path.join(SCRIPT_DIR, '.env.local'))

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
INTERNAL_SECRET = os.getenv('DEEPMONEY_INTERNAL_SECRET')
NEXTAUTH_URL = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
API_URL = f"{NEXTAUTH_URL}/api/prediction/deepmoney?refresh=true"

def sync_deepmoney():
    print(f"[{datetime.now()}] Starting DeepMoney sync...")
    
    # 1. Fetch data from API (V2)
    headers = {'x-api-key': INTERNAL_SECRET}
    try:
        response = requests.get(API_URL, headers=headers)
        
        # Handle environment variable quote mismatch
        if response.status_code == 401 and INTERNAL_SECRET:
            if not (INTERNAL_SECRET.startswith('"') and INTERNAL_SECRET.endswith('"')):
                print("Retrying with quoted secret...")
                headers = {'x-api-key': f'"{INTERNAL_SECRET}"'}
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