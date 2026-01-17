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
from datetime import datetime

# Disable SSL certificate verification for local development
os.environ['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

def create_db_connection():
    """Creates and returns a database connection."""
    load_dotenv('.env.local')
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
    """Fetches all stocks (id, symbol) from the Stock table."""
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, symbol FROM stocks")
        stocks = cursor.fetchall()
        print(f"Found {len(stocks)} stocks to process.")
        return stocks
    except Error as e:
        print(f"Error fetching stocks: {e}")
        return []
    finally:
        cursor.close()

def fetch_historical_data(symbol):
    """Fetches historical stock data for a given stock symbol from the local API."""
    api_url = f"http://localhost:3001/api/stock/{symbol}/historical/max"
    
    try:
        print(f"Fetching historical data for {symbol} from {api_url}")
        response = requests.get(api_url)
        response.raise_for_status()  # Raise an exception for HTTP errors
        return response.json()
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
            `adj_open`, `adj_high`, `adj_low`, `adj_close`, `adj_volume`
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            `adj_volume` = VALUES(`adj_volume`)
    """
    records_to_insert = []
    for record in daily_data:
        # The API might return 'timestamp', 'date', or 'datetime'. We need to handle all.
        date_str = record.get('timestamp') or record.get('date') or record.get('datetime')
        if not date_str:
            continue

        # The date might have a 'T' or a space and time part, so we split it.
        formatted_date = date_str.split('T')[0].split(' ')[0]

        records_to_insert.append((
            stock_id,
            formatted_date,
            record.get('open'),
            record.get('high'),
            record.get('low'),
            record.get('close'),
            record.get('volume'),
            record.get('adjOpen') or record.get('open'), # Fallback to open if adjOpen is not present
            record.get('adjHigh') or record.get('high'), # Fallback to high if adjHigh is not present
            record.get('adjLow') or record.get('low'),   # Fallback to low if adjLow is not present
            record.get('adjClose') or record.get('close'),# Fallback to close if adjClose is not present
            record.get('adjVolume') or record.get('volume') # Fallback to volume if adjVolume is not present
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

def main():
    """Main function to orchestrate the data population process."""
    db_connection = create_db_connection()
    if not db_connection:
        return

    stocks = fetch_stocks(db_connection)
    if not stocks:
        db_connection.close()
        return

    for stock in stocks:
        stock_id = stock['id']
        symbol = stock['symbol']

        historical_data = fetch_historical_data(symbol)
        if historical_data is not None and len(historical_data) > 0:
            upsert_daily_prices(db_connection, stock_id, historical_data)
            
            # Update the stock price with the most recent close price from historical data
            latest_price = historical_data[-1].get('close')
            if latest_price is not None:
                update_stock_price(db_connection, stock_id, latest_price)
        elif historical_data and 'error' in historical_data:
            print(f"API returned an error for {symbol}: {historical_data['error']}")
        else:
            print(f"No historical data returned for {symbol}.")
        print("-" * 30)

    db_connection.close()
    print("Script finished.")

if __name__ == "__main__":
    main()