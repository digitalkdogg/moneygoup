# populate_daily_prices.py
#
# This script populates the StockDailyPrice table with historical data for all stocks
# listed in the Stock table. It fetches the data from the local application's API.
#
# Required packages:
# pip install mysql-connector-python python-dotenv requests
#
# To run the script:
# 1. Make sure your local development server is running.
# 2. Run the script from your terminal: python populate_daily_prices.py

import os
import requests
import mysql.connector
from mysql.connector import Error
from dotenv import load_dotenv
from datetime import datetime, timedelta
from textblob import TextBlob # For sentiment analysis

# Disable SSL certificate verification for local development
os.environ['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

# Load environment variables from the correct .env file
env_file = os.getenv('DOTENV_FILE', '.env.local')
load_dotenv(env_file)
print(f"Loading environment variables from {env_file}")

# Get NEXTAUTH_URL from environment, default to http://localhost:3001 if not set
APP_HOST = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
print(f"Using APP_HOST: {APP_HOST}")

def create_db_connection():
    """Creates and returns a database connection."""
    try:
        connection = mysql.connector.connect(
            host=os.getenv('DB_HOST'),
            user=os.getenv('DB_USER'),
            password=os.getenv('DB_PASSWORD'),
            database=os.getenv('DB_DATABASE')
        )
        if connection.is_connected():
            print("Successfully connected to the database")
            return connection
    except Error as e:
        print(f"Error while connecting to MySQL: {e}")
    return None

def fetch_stocks(connection):
    """Fetches all stocks (id, symbol, company_name) from the Stock table."""
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, symbol, company_name FROM stocks")
        stocks = cursor.fetchall()
        print(f"Found {len(stocks)} stocks to process.")
        return stocks
    except Error as e:
        print(f"Error fetching stocks: {e}")
        return []
    finally:
        cursor.close()

def fetch_user_stocks(connection):
    """Fetches all user_stock entries (user_id, stock_id) from the user_stocks table."""
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute("SELECT user_id, stock_id FROM user_stocks")
        user_stocks = cursor.fetchall()
        print(f"Found {len(user_stocks)} user_stock entries.")
        return user_stocks
    except Error as e:
        print(f"Error fetching user_stocks: {e}")
        return []
    finally:
        cursor.close()

def fetch_historical_data(symbol):
    """Fetches historical stock data for a given stock symbol from the local API."""
    # Use the APP_HOST global variable
    api_url = f"{APP_HOST}/api/stock/{symbol}/historical/max"
    
    try:
        print(f"Fetching historical data for {symbol} from {api_url}")
        response = requests.get(api_url)
        response.raise_for_status()  # Raise an exception for HTTP errors
        json_response = response.json()
        if isinstance(json_response, dict) and 'historicalData' in json_response:
            return json_response['historicalData']
        print(f"Unexpected API response format for {symbol}: {json_response}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"Error fetching historical stock data for {symbol}: {e}")
        return None

def update_stock_price(connection, stock_id, price):
    """Updates the price of a stock in the stocks table."""
    cursor = connection.cursor()
    try:
        cursor.execute("UPDATE stocks SET price = %s WHERE id = %s", (str(price), stock_id))
        connection.commit()
        print(f"Successfully updated price for stock_id {stock_id} to {price}.")
    except Error as e:
        print(f"Error updating stock price for stock_id {stock_id}: {e}")
        connection.rollback()
    finally:
        cursor.close()


def upsert_daily_prices(connection, stock_id, daily_data):
    """
    Upserts a list of daily price records into the stocksdailyprice table.
    It will insert a new record or update an existing one if the stock_id and date match.
    """
    cursor = connection.cursor()
    upsert_query = """
        INSERT INTO stocksdailyprice (
            stock_id, `date`, `open`, `high`, `low`, `close`, `volume`,
            `adj_open`, `adj_high`, `adj_low`, `adj_close`, `adj_volume`, `daily_change`
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            `open` = VALUES(`open`),
            `high` = VALUES(`high`),
            `low` = VALUES(`low`),
            `close` = VALUES(`close`),
            `volume` = VALUES(`volume`),
            `adj_open` = VALUES(`adj_open`),
            `adj_high` = VALUES(`adj_high`),
            `adj_low` = VALUES(`adj_low`),
            `adj_close` = VALUES(`adj_close`),
            `adj_volume` = VALUES(`adj_volume`),
            `daily_change` = VALUES(`daily_change`)
    """
    
    # Sort data by date to ensure correct daily_change calculation
    daily_data.sort(key=lambda x: x.get('date') or x.get('datetime') or x.get('timestamp'))

    records_to_insert = []
    for i, record in enumerate(daily_data):
        # The API might return 'timestamp', 'date', or 'datetime'. We need to handle all.
        date_str = record.get('timestamp') or record.get('date') or record.get('datetime')
        if not date_str:
            continue

        # The date might have a 'T' or a space and time part, so we split it.
        formatted_date = date_str.split('T')[0].split(' ')[0]

        current_close = record.get('close')
        daily_change = 0.0

        if i > 0:
            prev_close = daily_data[i-1].get('close')
            if current_close is not None and prev_close is not None:
                daily_change = current_close - prev_close

        records_to_insert.append((
            stock_id,
            formatted_date,
            record.get('open'),
            record.get('high'),
            record.get('low'),
            current_close,
            record.get('volume'),
            record.get('adjOpen') or record.get('open'), # Fallback to open if adjOpen is not present
            record.get('adjHigh') or record.get('high'), # Fallback to high if adjHigh is not present
            record.get('adjLow') or record.get('low'),   # Fallback to low if adjLow is not present
            record.get('adjClose') or record.get('close'),# Fallback to close if adjClose is not present
            record.get('adjVolume') or record.get('volume'), # Fallback to volume if adjVolume is not present
            daily_change
        ))

    if not records_to_insert:
        print("No valid records to insert.")
        return

    try:
        cursor.executemany(upsert_query, records_to_insert)
        connection.commit()
        print(f"Successfully upserted {cursor.rowcount} records for stock_id {stock_id}.")
    except Error as e:
        print(f"Error during upsert for stock_id {stock_id}: {e}")
        connection.rollback()
    finally:
        cursor.close()

def mock_fetch_news(stock_symbol, company_name):
    """Mocks fetching news for a given stock symbol and company name."""
    mock_articles = []
    today = datetime.now()

    # Generate some positive, negative, and neutral headlines
    headlines = [
        f"{company_name} (S: {stock_symbol}) reports strong earnings, stock soars!", # Positive
        f"Analysts downgrade {company_name} (S: {stock_symbol}) amid market uncertainty.", # Negative
        f"{company_name} (S: {stock_symbol}) unveils new product line.", # Neutral
        f"Major partnership announced for {company_name} (S: {stock_symbol}).", # Positive
        f"{company_name} (S: {stock_symbol}) faces regulatory challenges.", # Negative
        f"Stock split for {company_name} (S: {stock_symbol}) expected next quarter.", # Neutral
    ]

    for i, headline in enumerate(headlines):
        mock_articles.append({
            'title': headline,
            'link': f"http://example.com/news/{stock_symbol}/{i}",
            'pub_date': today - timedelta(days=i), # Simulate recent news
            'source': "MockNewsProvider",
        })
    return mock_articles

def calculate_sentiment(text):
    """Calculates sentiment score using TextBlob."""
    analysis = TextBlob(text)
    return analysis.sentiment.polarity # Polarity ranges from -1.0 (negative) to 1.0 (positive)

def upsert_news(connection, news_items):
    """Upserts news items into the 'news' table."""
    cursor = connection.cursor()
    upsert_query = """
        INSERT INTO news (title, link, pub_date, source, sentiment_score, created_at)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            title = VALUES(title),
            pub_date = VALUES(pub_date),
            source = VALUES(source),
            sentiment_score = VALUES(sentiment_score),
            created_at = VALUES(created_at)
    """
    records_to_insert = []
    for item in news_items:
        records_to_insert.append((
            item['title'],
            item['link'],
            item['pub_date'],
            item['source'],
            item['sentiment_score'],
            datetime.now()
        ))
    
    if not records_to_insert:
        print("No news records to insert.")
        return []

    try:
        cursor.executemany(upsert_query, records_to_insert)
        connection.commit()
        print(f"Successfully upserted {cursor.rowcount} news records.")
        
        # Fetch IDs for newly inserted/updated news items (assuming link is unique)
        inserted_news_ids = []
        for item in news_items:
            cursor.execute("SELECT id FROM news WHERE link = %s", (item['link'],))
            result = cursor.fetchone()
            if result:
                inserted_news_ids.append(result[0])
        return inserted_news_ids
    except Error as e:
        print(f"Error during news upsert: {e}")
        connection.rollback()
        return []
    finally:
        cursor.close()

def link_news_to_user_stocks(connection, user_id, stock_id, news_ids):
    """Links news items to a specific user_stock entry in 'user_stock_news' table."""
    cursor = connection.cursor()
    insert_query = """
        INSERT IGNORE INTO user_stock_news (user_id, stock_id, news_id)
        VALUES (%s, %s, %s)
    """
    records_to_insert = []
    for news_id in news_ids:
        records_to_insert.append((user_id, stock_id, news_id))
    
    if not records_to_insert:
        return

    try:
        cursor.executemany(insert_query, records_to_insert)
        connection.commit()
        print(f"Successfully linked {cursor.rowcount} news items to user_stock ({user_id}, {stock_id}).")
    except Error as e:
        print(f"Error linking news to user_stock ({user_id}, {stock_id}): {e}")
        connection.rollback()
    finally:
        cursor.close()

def main():
    """Main function to orchestrate the data population process."""
    db_connection = create_db_connection()
    if not db_connection:
        return

    stocks = fetch_stocks(db_connection)
    if not stocks:
        db_connection.close()
        return
    
    user_stocks = fetch_user_stocks(db_connection)

    for stock in stocks:
        stock_id = stock['id']
        symbol = stock['symbol']
        company_name = stock.get('company_name', symbol) # Use symbol as fallback if company_name not present

        print(f"\nProcessing data for {symbol} ({company_name})...")

        # --- Process Real-time Price from Next.js API ---
        try:
            nextjs_api_url = f"{APP_HOST}/api/stock/quote/{symbol}"
            print(f"Fetching real-time price from Next.js API: {nextjs_api_url}")
            response = requests.get(nextjs_api_url)
            response.raise_for_status() # Raise an exception for HTTP errors
            quote_data = response.json()
            realtime_price = quote_data.get('price')

            if realtime_price is not None:
                update_stock_price(db_connection, stock_id, realtime_price)
            else:
                print(f"No real-time price found in Next.js API response for {symbol}.")

        except requests.exceptions.RequestException as e:
            print(f"Error fetching real-time price from Next.js API for {symbol}: {e}")
        except Exception as e:
            print(f"An unexpected error occurred while processing real-time price for {symbol}: {e}")

        # --- Process Historical Prices ---
        historical_data = fetch_historical_data(symbol)
        if historical_data is not None and len(historical_data) > 0:
            upsert_daily_prices(db_connection, stock_id, historical_data)
        
        # --- Process News ---
        print(f"Processing news for {symbol} ({company_name})...")
        mock_news_items = mock_fetch_news(symbol, company_name)
        
        # Calculate sentiment for each mock news item
        for item in mock_news_items:
            item['sentiment_score'] = calculate_sentiment(item['title'])
        
        # Upsert news into the 'news' table and get their IDs
        news_ids = upsert_news(db_connection, mock_news_items)

        if news_ids:
            # Link news to all relevant user_stocks entries
            for us in user_stocks:
                if us['stock_id'] == stock_id:
                    link_news_to_user_stocks(db_connection, us['user_id'], us['stock_id'], news_ids)
        else:
            print(f"No news IDs returned for {symbol}, skipping linking.")

        print("-" * 30)

    db_connection.close()
    print("Script finished.")

if __name__ == "__main__":
    main()