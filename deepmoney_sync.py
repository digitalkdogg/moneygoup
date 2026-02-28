
import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv

# Load environment variables: .env.production takes precedence, then .env.local
if os.path.exists('.env.production'):
    load_dotenv('.env.production')
load_dotenv('.env.local')

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
INTERNAL_SECRET = os.getenv('DEEPMONEY_INTERNAL_SECRET')
NEXTAUTH_URL = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
API_URL = f"{NEXTAUTH_URL}/api/deepmoney"

def sync_deepmoney():
    print(f"[{datetime.now()}] Starting DeepMoney sync...")
    
    # 1. Fetch data from API
    headers = {'x-api-key': INTERNAL_SECRET}
    try:
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
        # 3. Clear existing data
        print("Clearing existing recommendation data...")
        cursor.execute("DELETE FROM recommended_stocks")
        cursor.execute("DELETE FROM recommended_markets")

        # 4. Process Stocks
        stock_types = ['hot_stocks', 'hot_ai_tech_stocks']
        for s_type in stock_types:
            stocks = data.get(s_type, [])
            for s in stocks:
                upsert_query = """
                INSERT INTO recommended_stocks 
                (type, ticker, company_name, current_price, gps_score, classification, 
                 analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct, 
                 market_cap_m, mention_count, discovery_source, snapshot_date)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE 
                company_name=VALUES(company_name), current_price=VALUES(current_price),
                gps_score=VALUES(gps_score), classification=VALUES(classification),
                analyst_upside_pct=VALUES(analyst_upside_pct), revenue_growth_yoy=VALUES(revenue_growth_yoy),
                gross_margin_pct=VALUES(gross_margin_pct), rd_spend_pct=VALUES(rd_spend_pct),
                market_cap_m=VALUES(market_cap_m), mention_count=VALUES(mention_count),
                discovery_source=VALUES(discovery_source)
                """
                cursor.execute(upsert_query, (
                    s_type, s['ticker'], s['company_name'], s['current_price'], 
                    s['gps_score'], s['classification'], s['analyst_upside_pct'], 
                    s['revenue_growth_yoy'], s['gross_margin_pct'], s['rd_spend_pct'], 
                    s['market_cap_m'], s['mention_count'], s['discovery_source'], today
                ))

        # 4. Process Markets/Sectors
        market_mappings = [
            {'key': 'hot_markets', 'type': 'hot_markets', 'name_field': 'industry', 'count_field': 'count'},
            {'key': 'hot_ai_sectors', 'type': 'hot_ai_sectors', 'name_field': 'sub_sector', 'count_field': 'article_count'}
        ]
        
        for mapping in market_mappings:
            items = data.get(mapping['key'], [])
            for item in items:
                upsert_query = """
                INSERT INTO recommended_markets 
                (type, name, average_sentiment, count, snapshot_date)
                VALUES (%s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE 
                average_sentiment=VALUES(average_sentiment), count=VALUES(count)
                """
                cursor.execute(upsert_query, (
                    mapping['type'], item[mapping['name_field']], 
                    item['average_sentiment'], item[mapping['count_field']], today
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
