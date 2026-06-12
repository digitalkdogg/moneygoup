"""Shared utility for recording predictions to prediction_records table."""

import mysql.connector
from datetime import datetime
import os
from dotenv import load_dotenv

# Load environment variables
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')


def record_prediction(
    symbol: str,
    price_at_prediction: float,
    predicted_price_1w: float | None = None,
    predicted_price_1m: float | None = None,
    predicted_price_6m: float | None = None,
    predicted_price_1y: float | None = None,
) -> bool:
    """
    Record a prediction to prediction_records table.

    Uses INSERT IGNORE to silently skip duplicates (one per symbol per day).
    Returns True if inserted, False if duplicate/error.
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_DATABASE,
        )
        cursor = conn.cursor()

        query = """
        INSERT INTO prediction_records (
            symbol, predicted_at, price_at_prediction,
            predicted_price_1w, predicted_price_1m, predicted_price_6m, predicted_price_1y
        ) VALUES (%s, CURDATE(), %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            price_at_prediction = VALUES(price_at_prediction),
            predicted_price_1w = COALESCE(VALUES(predicted_price_1w), predicted_price_1w),
            predicted_price_1m = COALESCE(VALUES(predicted_price_1m), predicted_price_1m),
            predicted_price_6m = COALESCE(VALUES(predicted_price_6m), predicted_price_6m),
            predicted_price_1y = COALESCE(VALUES(predicted_price_1y), predicted_price_1y),
            updated_at = NOW()
        """

        cursor.execute(query, (
            symbol,
            price_at_prediction,
            predicted_price_1w if predicted_price_1w and predicted_price_1w > 0 else None,
            predicted_price_1m if predicted_price_1m and predicted_price_1m > 0 else None,
            predicted_price_6m if predicted_price_6m and predicted_price_6m > 0 else None,
            predicted_price_1y if predicted_price_1y and predicted_price_1y > 0 else None,
        ))

        # Check if row was inserted or updated
        inserted = cursor.rowcount > 0

        if inserted:
            conn.commit()
            print(f"  [analytics] Prediction recorded for {symbol}")
        else:
            # Duplicate for this symbol today
            print(f"  [analytics] Duplicate prediction (ignored) for {symbol} on same day")

        cursor.close()
        conn.close()
        return inserted

    except Exception as e:
        print(f"  [analytics] ERROR recording prediction for {symbol}: {e}")
        return False
