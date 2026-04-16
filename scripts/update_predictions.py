import json
import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv
 
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
 
INTERNAL_SECRET = os.getenv('DEEPMONEY_INTERNAL_SECRET')
NEXTAUTH_URL    = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
 
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
      AND (
          (us.is_purchased = 1 AND us.shares > 0 AND us.is_active = 1) -- Portfolio
          OR 
          (us.is_purchased = 0 AND us.shares = 0 and us.user_confirmed = 1)                     -- Watchlist
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
# payload that the prediction engine requires (≥504 rows of history).
# ---------------------------------------------------------------------------
def fetch_stock_data(ticker: str) -> dict | None:
    url = f"{NEXTAUTH_URL}/api/stock_data/{ticker}/data"
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
def run_prediction(ticker: str, stock_data: dict) -> float | None:
    url = f"{NEXTAUTH_URL}/api/prediction/{ticker}"
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
        return float(price)
    except Exception as exc:
        print(f"  [pred] ERROR running prediction for {ticker}: {exc}")
        return None
 
 
# ---------------------------------------------------------------------------
# Step 4 – Persist via POST /api/prediction/save
#
# The save endpoint resolves the ticker to a stock_id internally, so we only
# need to pass ticker, predicted_price_1m, and user_id (for internal calls).
# ---------------------------------------------------------------------------
def save_prediction(ticker: str, predicted_price: float, user_id: int) -> bool:
    url = f"{NEXTAUTH_URL}/api/prediction/save"
    payload = {
        'ticker':              ticker,
        'predicted_price_1m':  predicted_price,
        'user_id':             str(user_id),
    }
    try:
        response = post_with_auth(url, payload)
        if response.ok:
            print(f"  [save] Saved prediction for user {user_id} / {ticker}")
            return True
        else:
            print(f"  [save] WARNING: save returned {response.status_code} for user {user_id} / {ticker}: {response.text}")
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
    # prediction_cache: ticker → predicted_price_1m (or None on failure)
    # Keyed by ticker so we run the expensive model only once per stock,
    # regardless of how many users hold it.
    prediction_cache: dict[str, float | None] = {}
 
    stats = {'predicted': 0, 'cached': 0, 'saved': 0, 'skipped': 0, 'errors': 0}
 
    for row in rows:
        ticker  = row['ticker']
        user_id = row['user_id']
 
        print(f"\n→ user_id={user_id} ({row['username']})  ticker={ticker}")
 
        # Check cache first (nice-to-have: avoid re-running model for shared stocks)
        if ticker in prediction_cache:
            predicted_price = prediction_cache[ticker]
            print(f"  [cache] Using cached prediction for {ticker}: {predicted_price}")
            stats['cached'] += 1
        else:
            # Fetch enriched data from the data endpoint
            stock_data = fetch_stock_data(ticker)
            if stock_data is None:
                prediction_cache[ticker] = None
                stats['errors'] += 1
                continue
 
            # Validate minimum history depth (same gate as the API route: 504 rows)
            historical = stock_data.get('historicalData', [])
            if not historical or len(historical) < 504:
                print(f"  [data] SKIP {ticker}: only {len(historical)} days of history "
                      f"(minimum 504 required).")
                prediction_cache[ticker] = None
                stats['skipped'] += 1
                continue
 
            # Run the prediction model
            predicted_price = run_prediction(ticker, stock_data)
            prediction_cache[ticker] = predicted_price
            if predicted_price is not None:
                stats['predicted'] += 1
            else:
                stats['errors'] += 1
 
        # Skip saving if the prediction failed
        if predicted_price is None:
            print(f"  [save] Skipping save for user {user_id} / {ticker} (no prediction).")
            continue
 
        # Save the prediction for this user
        saved = save_prediction(ticker, predicted_price, user_id)
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