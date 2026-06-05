import json
import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# GPS v3.0 — mirrors src/utils/gps.ts exactly (8 components, 100 pts).
# Keep this in sync whenever gps.ts changes.
# ---------------------------------------------------------------------------
_CONSENSUS_POINTS = {
    'strongBuy': 9, 'strong_buy': 9,
    'buy': 7, 'hold': 4, 'underperform': 2, 'sell': 0,
}

def _recommendation_mean_to_key(mean) -> str:
    """Convert Yahoo Finance recommendationMean (1=strong buy … 5=sell) to key."""
    if mean is None:
        return 'hold'
    if mean <= 1.5:
        return 'strongBuy'
    if mean <= 2.5:
        return 'buy'
    if mean <= 3.5:
        return 'hold'
    if mean <= 4.5:
        return 'underperform'
    return 'sell'

def calculate_gps_v3(
    predicted_change_pct: float,
    confidence_score: float,
    revenue_growth: float,
    earnings_growth: float,
    technical_score: float,
    analyst_upside: float,
    recommendation_key: str,
    price_change_52w: float,
) -> dict:
    prediction_max = float(os.getenv('GPS_PREDICTION_MAX', '3'))

    # 1. ML Predicted Change 1m (20 pts)
    m1 = min(max(predicted_change_pct / prediction_max, -1), 1) * 20
    # 2. AI Model Confidence (5 pts)
    m2 = (confidence_score / 100) * 5
    # 3. Revenue Growth YoY (12 pts — full at 30%)
    m3 = min(max(revenue_growth / 0.3, 0), 1) * 12
    # 4. Earnings Growth YoY (12 pts — full at 25%)
    m4 = min(max(earnings_growth / 0.25, 0), 1) * 12
    # 5. Technical Signal (20 pts — raw -14..+14 mapped linearly to 0..20)
    m5 = min(max((technical_score + 14) / 28, 0), 1) * 20
    # 6. Analyst Price Target Upside (12 pts — full at 30%)
    m6 = min(max(analyst_upside / 0.3, 0), 1) * 12
    # 7. Analyst Consensus Rating (9 pts)
    m7 = float(_CONSENSUS_POINTS.get(recommendation_key, _CONSENSUS_POINTS['hold']))
    # 8. 52-Week Momentum (10 pts — full at 20%)
    m8 = min(max(price_change_52w / 0.2, 0), 1) * 10

    total = m1 + m2 + m3 + m4 + m5 + m6 + m7 + m8
    score = round(min(max(total, 0), 100), 1)

    return {
        'score': score,
        'breakdown': {
            'mlpUpside':        round(m1, 1),
            'mlpConfidence':    round(m2, 1),
            'revenueGrowth':    round(m3, 1),
            'earningsGrowth':   round(m4, 1),
            'technicalSignal':  round(m5, 1),
            'analystUpside':    round(m6, 1),
            'analystConsensus': round(m7, 1),
            'priceChange52w':   round(m8, 1),
        },
        'bearishSignal': predicted_change_pct < 0,
    }
 
# ---------------------------------------------------------------------------
# Load environment variables from the same directory as this script,
# mirroring the convention used in deepmoney_sync.py.
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))
 
DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
 
INTERNAL_SECRET  = os.getenv('DEEPMONEY_INTERNAL_SECRET')
INTERNAL_API_URL = 'http://localhost:3001'
 
# ---------------------------------------------------------------------------
# Build the auth header the same way deepmoney_sync.py does, including the
# quote-mismatch retry logic for environments where the secret is stored with
# surrounding quotes.
# ---------------------------------------------------------------------------
def make_headers() -> dict:
    return {'x-api-key': INTERNAL_SECRET, 'Content-Type': 'application/json'}
 
 
def get_with_auth(url: str) -> requests.Response:
    """GET with internal API key, retrying with quoted secret on 401."""
    headers = make_headers()
    response = requests.get(url, headers=headers)
 
    if response.status_code == 401 and INTERNAL_SECRET:
        if not (INTERNAL_SECRET.startswith('"') and INTERNAL_SECRET.endswith('"')):
            print("  [auth] Retrying GET with quoted secret...")
            headers['x-api-key'] = f'"{INTERNAL_SECRET}"'
            response = requests.get(url, headers=headers)
 
    return response
 
 
def post_with_auth(url: str, payload: dict) -> requests.Response:
    """POST with internal API key, retrying with quoted secret on 401."""
    headers = make_headers()
    response = requests.post(url, headers=headers, json=payload)
 
    if response.status_code == 401 and INTERNAL_SECRET:
        if not (INTERNAL_SECRET.startswith('"') and INTERNAL_SECRET.endswith('"')):
            print("  [auth] Retrying POST with quoted secret...")
            headers['x-api-key'] = f'"{INTERNAL_SECRET}"'
            response = requests.post(url, headers=headers, json=payload)
 
    return response
 
 
# ---------------------------------------------------------------------------
# Database helper
# ---------------------------------------------------------------------------
def get_db_connection():
    return mysql.connector.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_DATABASE,
    )
 
 
# ---------------------------------------------------------------------------
# Step 1 – Query active portfolio stocks for users who logged in within 7 days
#
# Returns a list of dicts: { user_id, user_email_or_id, stock_id, ticker }
# We join users → user_stocks → stocks and filter on:
#   • users.last_login within the past 7 days
#   • user_stocks.is_purchased = 1  (portfolio, not watchlist)
#   • user_stocks.shares > 0        (still an active position)
#   • user_stocks.is_active = 1     (not closed)
# ---------------------------------------------------------------------------
ACTIVE_PORTFOLIO_QUERY = """
    SELECT
        u.id         AS user_id,
        u.username   AS username,
        s.id         AS stock_id,
        s.symbol     AS ticker
    FROM users u
    JOIN user_stocks us ON us.user_id = u.id
    JOIN stocks      s  ON s.id       = us.stock_id
    WHERE u.last_login >= NOW() - INTERVAL 7 DAY
      AND us.is_active = 1
      AND us.user_confirmed = 1
      AND (
          (us.is_purchased = 1 AND us.shares > 0) -- Portfolio
          OR 
          (us.is_purchased = 0)                   -- Watchlist
      )
    ORDER BY s.symbol, u.id
"""
 
 
def fetch_active_portfolio_rows(cursor) -> list[dict]:
    cursor.execute(ACTIVE_PORTFOLIO_QUERY)
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]
 
 
# ---------------------------------------------------------------------------
# Step 2 – Fetch enriched stock data from /api/stock_data/[ticker]/data
#
# This endpoint assembles the full historicalData + stockMetrics + macroData
# payload that the prediction engine requires (≥365 rows of history).
# ---------------------------------------------------------------------------
def fetch_stock_data(ticker: str) -> dict | None:
    url = f"{INTERNAL_API_URL}/api/stock_data/{ticker}/data"
    print(f"  [data] Fetching enriched data for {ticker}...")
    try:
        response = get_with_auth(url)
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        print(f"  [data] ERROR fetching data for {ticker}: {exc}")
        return None
 
 
# ---------------------------------------------------------------------------
# Step 3 – Run the prediction model via POST /api/prediction/[ticker]
#
# The endpoint expects: { historicalData, stockMetrics, macroData?, newsArticles?, technicalScore? }
# It returns JSON that includes predicted_price_1m (and other horizons).
# ---------------------------------------------------------------------------
def run_prediction(ticker: str, stock_data: dict) -> dict | None:
    url = f"{INTERNAL_API_URL}/api/prediction/{ticker}?outlook=1_month"
    print(f"  [pred] Running prediction model for {ticker}...")
    try:
        response = post_with_auth(url, stock_data)
        response.raise_for_status()
        result = response.json()
        price = result.get('predicted_price_1m')
        if price is None:
            print(f"  [pred] WARNING: predicted_price_1m missing from response for {ticker}")
            return None
        print(f"  [pred] {ticker} → predicted_price_1m = {price}")
        return result
    except Exception as exc:
        print(f"  [pred] ERROR running prediction for {ticker}: {exc}")
        return None
 
 
# ---------------------------------------------------------------------------
# Step 4 – Persist via POST /api/prediction/save
#
# The save endpoint resolves the ticker to a stock_id internally, so we only
# need to pass ticker, predicted_price_1m, and user_id (for internal calls).
# ---------------------------------------------------------------------------
def save_prediction(ticker: str, predicted_price: float, user_id: int, gps_score: float = None, gps_breakdown: dict = None) -> bool:
    url = f"{INTERNAL_API_URL}/api/prediction/save"
    payload = {
        'ticker':              ticker,
        'predicted_price_1m':  predicted_price,
        'user_id':             str(user_id),
    }
    if gps_score is not None:
        payload['gps_score'] = gps_score
    if gps_breakdown is not None:
        payload['gps_breakdown'] = gps_breakdown
    
    try:
        response = post_with_auth(url, payload)
        if response.ok:
            print(f"  [save] Saved prediction for user {user_id} / {ticker}")
            return True
        else:
            try:
                resp_json = response.json()
                error_msg = resp_json.get('message', response.text)
                if 'errors' in resp_json:
                    error_msg += f" - {resp_json['errors']}"
            except:
                error_msg = response.text
            print(f"  [save] WARNING: save returned {response.status_code} for user {user_id} / {ticker}: {error_msg}")
            return False
    except Exception as exc:
        print(f"  [save] ERROR saving prediction for user {user_id} / {ticker}: {exc}")
        return False
 
 
# ---------------------------------------------------------------------------
# Main sync routine
# ---------------------------------------------------------------------------
def sync_portfolio_predictions():
    print(f"[{datetime.now()}] Starting portfolio prediction sync...")
 
    # --- Connect to DB ---------------------------------------------------
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
    except Exception as exc:
        print(f"ERROR connecting to database: {exc}")
        return
 
    # --- Fetch all active portfolio rows ---------------------------------
    try:
        rows = fetch_active_portfolio_rows(cursor)
    except Exception as exc:
        print(f"ERROR querying portfolio rows: {exc}")
        cursor.close()
        conn.close()
        return
 
    if not rows:
        print("No active portfolio stocks found for users active in the last 7 days. Done.")
        cursor.close()
        conn.close()
        return
 
    # Summarise what we found
    unique_users   = {r['user_id'] for r in rows}
    unique_tickers = {r['ticker']  for r in rows}
    print(f"Found {len(rows)} portfolio entries: "
          f"{len(unique_users)} user(s), {len(unique_tickers)} unique ticker(s).")
 
    # --- Process ---------------------------------------------------------
    # prediction_cache: ticker → (predicted_price_1m, gps_score, gps_breakdown) (or None on failure)
    # Keyed by ticker so we run the expensive model only once per stock,
    # regardless of how many users hold it.
    prediction_cache: dict[str, tuple[float | None, float | None, dict | None]] = {}
 
    stats = {'predicted': 0, 'cached': 0, 'saved': 0, 'skipped': 0, 'errors': 0}
 
    for row in rows:
        ticker  = row['ticker']
        user_id = row['user_id']
 
        print(f"\n→ user_id={user_id} ({row['username']})  ticker={ticker}")
 
        # Check cache first (nice-to-have: avoid re-running model for shared stocks)
        if ticker in prediction_cache:
            predicted_price, gps_score, gps_breakdown = prediction_cache[ticker]
            print(f"  [cache] Using cached prediction for {ticker}: {predicted_price} (GPS: {gps_score})")
            stats['cached'] += 1
        else:
            # Fetch enriched data from the data endpoint
            stock_data = fetch_stock_data(ticker)
            if stock_data is None:
                prediction_cache[ticker] = (None, None, None)
                stats['errors'] += 1
                continue
 
            # Validate minimum history depth (same gate as the API route: 365 rows)
            historical = stock_data.get('historicalData', [])
            if not historical or len(historical) < 365:
                print(f"  [data] SKIP {ticker}: only {len(historical)} days of history "
                      f"(minimum 365 required).")
                prediction_cache[ticker] = (None, None, None)
                stats['skipped'] += 1
                continue
 
            # Run the prediction model
            prediction_result = run_prediction(ticker, stock_data)

            # Calculate GPS Score
            gps_score = None
            predicted_price = None
            gps_breakdown = None
            if prediction_result is not None:
                stats['predicted'] += 1
                predicted_price = float(prediction_result.get('predicted_price_1m', 0))
                confidence_score = float(prediction_result.get('confidence_score', 0))

                # GPS v3.0 — matches src/utils/gps.ts exactly
                sm = stock_data.get('stockMetrics', {})
                # Prefer top-level recommendationKey (set by /data since GPS fix);
                # fall back to converting recommendationMean for older cached payloads.
                rec_key = (stock_data.get('recommendationKey')
                           or sm.get('recommendationKey')
                           or _recommendation_mean_to_key(sm.get('recommendationMean')))
                gps_result = calculate_gps_v3(
                    predicted_change_pct = prediction_result.get('predicted_change_pct', 0),
                    confidence_score     = confidence_score,
                    revenue_growth       = sm.get('revenueGrowth') or 0,
                    earnings_growth      = sm.get('earningsGrowth') or 0,
                    technical_score      = float(stock_data.get('technicalScore') or 0),
                    analyst_upside       = sm.get('analystUpside') or 0,
                    recommendation_key   = rec_key,
                    price_change_52w     = sm.get('fiftyTwoWeekChange') or 0,
                )
                gps_score     = gps_result['score']
                gps_breakdown = gps_result['breakdown']

                if gps_result['bearishSignal']:
                    print(f"  [gps] BEARISH SIGNAL for {ticker}: "
                          f"ML predicts {prediction_result.get('predicted_change_pct', 0):.2f}% → "
                          f"GPS={gps_score}")
                print(f"  [gps] GPS v3.0 score for {ticker}: {gps_score}")
                
            else:
                stats['errors'] += 1
            
            prediction_cache[ticker] = (predicted_price, gps_score, gps_breakdown)
 
        # Skip saving if the prediction failed
        if predicted_price is None:
            print(f"  [save] Skipping save for user {user_id} / {ticker} (no prediction).")
            continue
 
        # Save the prediction for this user
        saved = save_prediction(ticker, predicted_price, user_id, gps_score, gps_breakdown)
        if saved:
            stats['saved'] += 1
        else:
            stats['errors'] += 1
 
    # --- Wrap up ---------------------------------------------------------
    cursor.close()
    conn.close()
 
    print(f"\n[{datetime.now()}] Sync complete.")
    print(f"  Predictions run  : {stats['predicted']}")
    print(f"  Served from cache: {stats['cached']}")
    print(f"  Saves successful : {stats['saved']}")
    print(f"  Skipped (history): {stats['skipped']}")
    print(f"  Errors           : {stats['errors']}")
 
 
if __name__ == "__main__":
    sync_portfolio_predictions()