#!/usr/bin/env python3
import os
import sys
import mysql.connector
from mysql.connector import Error
from datetime import datetime, timedelta
import yfinance as yf
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT = int(os.getenv('DB_PORT', 3306))

def get_db_connection():
    return mysql.connector.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_DATABASE,
        port=DB_PORT,
        autocommit=False
    )

def get_trading_day_price(symbol: str, target_date: str) -> float | None:
    """Fetch closing price for target_date, or next available trading day."""
    try:
        target = datetime.strptime(target_date, '%Y-%m-%d')
        # end date is exclusive, so target + 6 days covers target, target+1, ..., target+5
        end_date = (target + timedelta(days=6)).strftime('%Y-%m-%d')
        
        data = yf.download(symbol, start=target_date, end=end_date, progress=False)
        if not data.empty:
            close_data = data['Close']
            close_series = close_data[symbol] if hasattr(close_data, 'columns') else close_data
            close_series = close_series.dropna()
            if not close_series.empty:
                return float(close_series.iloc[0])

        return None
    except Exception as e:
        print(f"Error fetching price for {symbol} on {target_date}: {e}")
        return None

# Per-horizon direction deadbands — predicted moves smaller than the threshold
# are treated as 'neutral' calls and excluded from the direction-accuracy metric
# (NULL) rather than counted wrong. 1m is raised to 3% because the LSTM 1m
# head produces noisier small-move predictions than the 1w or CS (3m/6m) heads.
DIRECTION_DEADBAND_PCT = {
    '1w': 0.02,
    '1m': 0.02,
    '3m': 0.02,
    '6m': 0.02,
}
_DEFAULT_DEADBAND = 0.02


def compute_accuracy_metrics(actual_price: float, predicted_price: float, price_at_prediction: float,
                              horizon: str = ''):
    """
    Compute proximity accuracy and direction correct.

    Proximity: max(0, (1 - abs(actual - predicted) / predicted) * 100)
    Direction: 1 if both moved same direction from price_at_prediction, 0 if opposite,
               None if the predicted move was inside the deadband (neutral call).
    """
    # Proximity accuracy
    if predicted_price == 0:
        accuracy_pct = 0.0
    else:
        accuracy_pct = max(0, (1 - abs(actual_price - predicted_price) / predicted_price) * 100)

    # Deadband: near-flat predicted moves are 'neutral' — excluded from direction metric.
    deadband = DIRECTION_DEADBAND_PCT.get(horizon, _DEFAULT_DEADBAND)
    if price_at_prediction > 0:
        pred_change_pct = (predicted_price - price_at_prediction) / price_at_prediction
        if abs(pred_change_pct) < deadband:
            return round(accuracy_pct, 2), None

    # Direction accuracy
    predicted_direction = 1 if predicted_price > price_at_prediction else (0 if predicted_price < price_at_prediction else -1)
    actual_direction = 1 if actual_price > price_at_prediction else (0 if actual_price < price_at_prediction else -1)

    if predicted_direction == -1 or actual_direction == -1:  # No movement predicted or actual
        direction_correct = 0
    else:
        direction_correct = 1 if predicted_direction == actual_direction else 0

    return round(accuracy_pct, 2), direction_correct

def resolve_horizon(conn, horizon: str, days_offset: int) -> tuple[int, int]:
    """
    Resolve one horizon (1w, 1m, 3m, 6m).
    Returns (resolved_count, skipped_count).
    """
    cursor = conn.cursor(dictionary=True)
    resolved = horizon.replace('_', '')  # '1w' -> 'resolved_1w'

    # Filter out rows where the prediction itself is NULL — those rows can
    # never be "resolved" (nothing to compare against), so loading them just
    # wastes a Yahoo fetch per run. Older prediction_records inserts
    # sometimes left longer-horizon columns NULL.
    query = f"""
    SELECT id, symbol, predicted_at, price_at_prediction, predicted_price_{horizon}
    FROM prediction_records
    WHERE resolved_{horizon} = 0
      AND predicted_price_{horizon} IS NOT NULL
      AND DATE_ADD(predicted_at, INTERVAL {days_offset} DAY) < CURDATE()
    LIMIT 1000
    """

    try:
        cursor.execute(query)
        rows = cursor.fetchall()

        resolved_count = 0
        skipped_count = 0

        for row in rows:
            record_id = row['id']
            symbol = row['symbol']
            # Handle both datetime.date and datetime.datetime objects
            predicted_at_obj = row['predicted_at']
            if hasattr(predicted_at_obj, 'strftime'):
                predicted_at = predicted_at_obj.strftime('%Y-%m-%d')
            else:
                predicted_at = str(predicted_at_obj)
            price_at_prediction = float(row['price_at_prediction'])
            predicted_price = row[f'predicted_price_{horizon}']

            if predicted_price is None:
                skipped_count += 1
                continue

            # Fetch actual price for target date
            target_date = (datetime.strptime(predicted_at, '%Y-%m-%d') + timedelta(days=days_offset)).strftime('%Y-%m-%d')
            actual_price = get_trading_day_price(symbol, target_date)

            if actual_price is None:
                skipped_count += 1
                continue

            # Compute metrics
            accuracy_pct, direction_correct = compute_accuracy_metrics(actual_price, float(predicted_price), price_at_prediction, horizon=horizon)

            # Update record
            update_query = f"""
            UPDATE prediction_records
            SET
              actual_price_{horizon} = %s,
              accuracy_pct_{horizon} = %s,
              direction_correct_{horizon} = %s,
              resolved_{horizon} = 1,
              updated_at = NOW()
            WHERE id = %s
            """

            cursor.execute(update_query, (actual_price, accuracy_pct, direction_correct, record_id))
            resolved_count += 1

        conn.commit()
        return resolved_count, skipped_count

    except Error as e:
        conn.rollback()
        print(f"Error resolving {horizon}: {e}")
        return 0, 0
    finally:
        cursor.close()

def main():
    try:
        conn = get_db_connection()

        print(f"[{datetime.now().isoformat()}] Starting prediction resolution...")

        total_resolved = 0
        total_skipped = 0

        horizons = [
            ('1w', 7),
            ('1m', 30),
            ('6m', 180),
            ('3m', 91),
        ]

        for horizon, days in horizons:
            resolved, skipped = resolve_horizon(conn, horizon, days)
            total_resolved += resolved
            total_skipped += skipped
            print(f"  {horizon}: {resolved} resolved, {skipped} skipped")

        print(f"[{datetime.now().isoformat()}] Resolution complete. Total: {total_resolved} resolved, {total_skipped} skipped")

        conn.close()

    except Error as e:
        print(f"Database error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
