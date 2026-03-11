
import json
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
API_URL = f"{NEXTAUTH_URL}/api/prediction/deepmoney?refresh=true"

def sync_deepmoney():
    print(f"[{datetime.now()}] Starting DeepMoney sync...")
    
    # 1. Fetch data from API
    headers = {'x-api-key': INTERNAL_SECRET}
    try:
        response = requests.get(API_URL, headers=headers)
        
        # Handle environment variable quote mismatch (common with some docker env loaders)
        if response.status_code == 401 and INTERNAL_SECRET:
            if not (INTERNAL_SECRET.startswith('"') and INTERNAL_SECRET.endswith('"')):
                print("Retrying with quoted secret...")
                headers = {'x-api-key': f'"{INTERNAL_SECRET}"'}
                response = requests.get(API_URL, headers=headers)
                print(f"{response}")
        
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
        cursor.execute("""
            DELETE FROM recommended_stocks
            WHERE type IN (
                'hot_stocks', 'hot_ai_tech_stocks',
                'undervalued_large_caps', 'breakout_candidates',
                'insider_activity', 'analyst_favorites'
            )
        """)
        cursor.execute("DELETE FROM recommended_markets")

        # 4. Process Stocks (hot_stocks, hot_ai_tech_stocks)
        stock_types = ['hot_stocks', 'hot_ai_tech_stocks']
        for s_type in stock_types:
            stocks = data.get(s_type, [])
            print(f"Processing {s_type} ({len(stocks)} candidates)...")
            for s in stocks:
                print(f"  > {s['ticker']}")
                upsert_query = """
                INSERT INTO recommended_stocks
                (type, ticker, company_name, current_price, gps_score, classification,
                 analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct,
                 market_cap_m, mention_count, discovery_source, trading_signal,
                 trading_signal_score, upcoming_earnings, prediction_input,
                 trailing_pe, price_to_book, metric_value, metric_label, snapshot_date)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                company_name=VALUES(company_name), current_price=VALUES(current_price),
                gps_score=VALUES(gps_score), classification=VALUES(classification),
                analyst_upside_pct=VALUES(analyst_upside_pct), revenue_growth_yoy=VALUES(revenue_growth_yoy),
                gross_margin_pct=VALUES(gross_margin_pct), rd_spend_pct=VALUES(rd_spend_pct),
                market_cap_m=VALUES(market_cap_m), mention_count=VALUES(mention_count),
                discovery_source=VALUES(discovery_source), trading_signal=VALUES(trading_signal),
                trading_signal_score=VALUES(trading_signal_score), upcoming_earnings=VALUES(upcoming_earnings),
                prediction_input=VALUES(prediction_input), trailing_pe=VALUES(trailing_pe),
                price_to_book=VALUES(price_to_book), metric_value=VALUES(metric_value),
                metric_label=VALUES(metric_label)
                """
                cursor.execute(upsert_query, (
                    s_type, s['ticker'], s['company_name'], s['current_price'],
                    s['gps_score'], s['classification'], s['analyst_upside_pct'],
                    s['revenue_growth_yoy'], s['gross_margin_pct'], s['rd_spend_pct'],
                    s['market_cap_m'], s['mention_count'], s['discovery_source'],
                    s.get('trading_signal'),
                    s.get('trading_signal_score'),
                    s.get('upcoming_earnings'),
                    json.dumps(s.get('prediction_input')),
                    None, None, None, None,
                    today
                ))

        # 4b. Process new screener types (undervalued_large_caps, breakout_candidates, insider_activity, analyst_favorites)
        INSERT_SQL = """
            INSERT INTO recommended_stocks (
                type, ticker, company_name, current_price, gps_score, classification,
                analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct,
                market_cap_m, mention_count, discovery_source, trading_signal,
                trading_signal_score, upcoming_earnings, prediction_input,
                trailing_pe, price_to_book, metric_value, metric_label,
                snapshot_date
            ) VALUES (
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s
            )
            ON DUPLICATE KEY UPDATE
                current_price = VALUES(current_price),
                trailing_pe   = VALUES(trailing_pe),
                price_to_book = VALUES(price_to_book),
                metric_value  = VALUES(metric_value),
                metric_label  = VALUES(metric_label),
                snapshot_date = VALUES(snapshot_date)
        """

        for list_key in ['undervalued_large_caps', 'breakout_candidates', 'insider_activity', 'analyst_favorites']:
            stocks = data.get(list_key, [])
            print(f"Processing {list_key} ({len(stocks)} candidates)...")
            for stock in stocks:
                print(f"  > {stock['ticker']}")
                cursor.execute(INSERT_SQL, (
                    list_key,
                    stock['ticker'],
                    stock['company_name'],
                    stock['current_price'],
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    stock.get('market_cap_m'),
                    0,
                    'screener',
                    None,
                    None,
                    None,
                    None,
                    stock.get('trailing_pe'),
                    stock.get('price_to_book'),
                    stock.get('metric_value'),
                    stock.get('metric_label'),
                    today
                ))

        # 5. Process Markets/Sectors
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

        # 6. Process ETFs
        print("Processing hot ETFs...")
        etfs = data.get('hot_etfs', [])
        for e in etfs:
            upsert_query = """
            INSERT INTO hot_etfs 
            (ticker, etf_name, snapshot_date, current_price, etf_gps_score, theme, 
             aum_m, expense_ratio_pct, 52wk_return_pct, 3mo_return_pct, avg_daily_volume, 
             momentum_score, news_signal_score, discovery_source, is_leveraged)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE 
            etf_name=VALUES(etf_name), current_price=VALUES(current_price), 
            etf_gps_score=VALUES(etf_gps_score), theme=VALUES(theme), aum_m=VALUES(aum_m), 
            expense_ratio_pct=VALUES(expense_ratio_pct), 52wk_return_pct=VALUES(52wk_return_pct), 
            3mo_return_pct=VALUES(3mo_return_pct), avg_daily_volume=VALUES(avg_daily_volume), 
            momentum_score=VALUES(momentum_score), news_signal_score=VALUES(news_signal_score), 
            discovery_source=VALUES(discovery_source), is_leveraged=VALUES(is_leveraged)
            """
            cursor.execute(upsert_query, (
                e['ticker'], e['etf_name'], e['snapshot_date'], e['current_price'], 
                e['etf_gps_score'], e['theme'], e['aum_m'], e['expense_ratio_pct'], 
                e['fiftyTwoWk_return_pct'], e['threeMo_return_pct'], e['avg_daily_volume'], 
                e['momentum_score'], e['news_signal_score'], 
                e['discovery_source'], 1 if e['is_leveraged'] else 0
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
