"""Shared utility for recording predictions to prediction_records table."""

import json
import mysql.connector
import os
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')


def _pos(v):
    """Return v if it's a positive number, else None."""
    try:
        return v if v is not None and float(v) > 0 else None
    except (TypeError, ValueError):
        return None


def _num(v):
    """Return v as-is if it looks numeric, else None."""
    if v is None:
        return None
    try:
        float(v)
        return v
    except (TypeError, ValueError):
        return None


def record_prediction(
    symbol: str,
    price_at_prediction: float,
    predicted_price_1w: float | None = None,
    predicted_price_1m: float | None = None,
    predicted_price_6m: float | None = None,
    predicted_price_1y: float | None = None,
    predicted_change_pct_1w: float | None = None,
    predicted_change_pct_1m: float | None = None,
    predicted_change_pct_6m: float | None = None,
    predicted_change_pct_1y: float | None = None,
    confidence_score_1w: float | None = None,
    confidence_score_1m: float | None = None,
    confidence_score_6m: float | None = None,
    confidence_score_1y: float | None = None,
    gps_score: float | None = None,
    gps_breakdown: dict | None = None,
    accuracy_metrics: dict | None = None,
    data_quality: dict | None = None,
    model_status: str | None = None,
    model_version: str = 'legacy',
) -> bool:
    """Insert a fresh prediction_records row (one per run — no dedup index)."""
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
            symbol, predicted_at, model_version, price_at_prediction,
            predicted_price_1w, predicted_price_1m, predicted_price_6m, predicted_price_1y,
            predicted_change_pct_1w, predicted_change_pct_1m, predicted_change_pct_6m, predicted_change_pct_1y,
            confidence_score_1w, confidence_score_1m, confidence_score_6m, confidence_score_1y,
            gps_score, gps_breakdown,
            accuracy_metrics, data_quality, model_status
        ) VALUES (%s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """

        gps_breakdown_json    = json.dumps(gps_breakdown)    if gps_breakdown    is not None else None
        accuracy_metrics_json = json.dumps(accuracy_metrics) if accuracy_metrics is not None else None
        data_quality_json     = json.dumps(data_quality)     if data_quality     is not None else None

        cursor.execute(query, (
            symbol,
            model_version,
            price_at_prediction,
            _pos(predicted_price_1w),
            _pos(predicted_price_1m),
            _pos(predicted_price_6m),
            _pos(predicted_price_1y),
            _num(predicted_change_pct_1w),
            _num(predicted_change_pct_1m),
            _num(predicted_change_pct_6m),
            _num(predicted_change_pct_1y),
            _num(confidence_score_1w),
            _num(confidence_score_1m),
            _num(confidence_score_6m),
            _num(confidence_score_1y),
            _num(gps_score),
            gps_breakdown_json,
            accuracy_metrics_json,
            data_quality_json,
            model_status,
        ))

        inserted = cursor.rowcount > 0
        conn.commit()

        if inserted:
            print(f"  [analytics] Prediction recorded for {symbol}")

        cursor.close()
        conn.close()
        return inserted

    except Exception as e:
        print(f"  [analytics] ERROR recording prediction for {symbol}: {e}")
        return False
