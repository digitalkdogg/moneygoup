import json
import os
import requests
import mysql.connector
import yfinance as yf
from datetime import datetime
from dotenv import load_dotenv
from prediction_recorder import record_prediction
from strategy_config import (
    DEFAULT_STRATEGY,
    resolve_strategy,
    get_all_user_strategies,
    strategy_bucket_key,
)  # aggressiveness-only after the timeframe removal
from etf_holding_preset import resolve_etf_holding_algorithm

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
    """Mirrors src/utils/gps.ts calculateGpsScore exactly."""
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
    """Run prediction for all 4 timeframes and merge results."""
    print(f"  [pred] Running prediction model for {ticker}...")
    try:
        predictions = {}
        timeframes = ['1_week', '1_month', '6_month', '1_year']

        for tf in timeframes:
            url = f"{INTERNAL_API_URL}/api/prediction/{ticker}?outlook={tf}"
            response = post_with_auth(url, stock_data)
            response.raise_for_status()
            result = response.json()
            predictions[tf] = result

        # Use 1_month as the base result
        result = predictions['1_month']
        price = result.get('predicted_price_1m')
        if price is None:
            print(f"  [pred] WARNING: predicted_price_1m missing from response for {ticker}")
            return None

        # Merge all timeframe predictions
        result['predicted_price_1w'] = predictions['1_week'].get('predicted_price')
        result['predicted_price_1m'] = predictions['1_month'].get('predicted_price')
        result['predicted_price_6m'] = predictions['6_month'].get('predicted_price')
        result['predicted_price_1y'] = predictions['1_year'].get('predicted_price')

        print(f"  [pred] {ticker} → 1w={result['predicted_price_1w']}, 1m={result['predicted_price_1m']}, 6m={result['predicted_price_6m']}, 1y={result['predicted_price_1y']}")
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
def save_prediction(
    ticker: str,
    predicted_price: float,
    user_id: int,
    gps_score: float = None,
    gps_breakdown: dict = None,
    predicted_price_1w: float = None,
    predicted_price_6m: float = None,
    predicted_price_1y: float = None,
    predicted_change_pct_1w: float = None,
    predicted_change_pct_1m: float = None,
    predicted_change_pct_6m: float = None,
    predicted_change_pct_1y: float = None,
    confidence_score_1w: float = None,
    confidence_score_1m: float = None,
    confidence_score_6m: float = None,
    confidence_score_1y: float = None,
) -> bool:
    """Persist a prediction. GPS goes to stock_gps_scores (one row per stock).
    All four horizon prices (1w/1m/6m/1y) are persisted to user_stock_predictions
    so the dashboard recommendations route can pick the right column based on
    the user's investment_timeframe setting. Per-horizon change% and confidence
    are also persisted so the dashboard can recompute GPS identically to the
    prediction page without re-deriving deltas from possibly-stale prices."""
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
    # Other-horizon prices are optional in the schema; only send when present
    # so the save route's surgical upsert leaves existing values alone if a run
    # produced a 1m result but no others.
    if predicted_price_1w is not None and predicted_price_1w > 0:
        payload['predicted_price_1w'] = predicted_price_1w
    if predicted_price_6m is not None and predicted_price_6m > 0:
        payload['predicted_price_6m'] = predicted_price_6m
    if predicted_price_1y is not None and predicted_price_1y > 0:
        payload['predicted_price_1y'] = predicted_price_1y
    if predicted_change_pct_1w is not None:
        payload['predicted_change_pct_1w'] = predicted_change_pct_1w
    if predicted_change_pct_1m is not None:
        payload['predicted_change_pct_1m'] = predicted_change_pct_1m
    if predicted_change_pct_6m is not None:
        payload['predicted_change_pct_6m'] = predicted_change_pct_6m
    if predicted_change_pct_1y is not None:
        payload['predicted_change_pct_1y'] = predicted_change_pct_1y
    if confidence_score_1w is not None:
        payload['confidence_score_1w'] = confidence_score_1w
    if confidence_score_1m is not None:
        payload['confidence_score_1m'] = confidence_score_1m
    if confidence_score_6m is not None:
        payload['confidence_score_6m'] = confidence_score_6m
    if confidence_score_1y is not None:
        payload['confidence_score_1y'] = confidence_score_1y
    
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
# Helpers for prediction cache
# ---------------------------------------------------------------------------
def _empty_cache_entry() -> dict:
    return {
        'predicted_price':      None,
        'predicted_price_1w':   None,
        'predicted_price_6m':   None,
        'predicted_price_1y':   None,
        'predicted_change_pct': None,
        'confidence_score':     None,
        'predicted_change_pct_1w': None,
        'predicted_change_pct_1m': None,
        'predicted_change_pct_6m': None,
        'predicted_change_pct_1y': None,
        'confidence_score_1w':     None,
        'confidence_score_1m':     None,
        'confidence_score_6m':     None,
        'confidence_score_1y':     None,
        'gps_score':            None,
        'gps_breakdown':        None,
        'gps_inputs':           None,
    }


# ---------------------------------------------------------------------------
# ETF holdings: detection + recommendation persistence
# ---------------------------------------------------------------------------
def fetch_etf_holdings(ticker: str, limit: int = 10) -> tuple[bool, list[str]]:
    """Call the holdings endpoint. Returns (is_etf, [holding_ticker, ...])."""
    url = f"{INTERNAL_API_URL}/api/stock_data/{ticker}/holdings?limit={limit}"
    try:
        response = get_with_auth(url)
        response.raise_for_status()
        data = response.json()
        is_etf = bool(data.get('isEtf'))
        tickers = [h['ticker'] for h in data.get('holdings', []) if h.get('ticker')]
        return is_etf, tickers
    except Exception as exc:
        print(f"  [etf] WARNING: could not fetch holdings for {ticker}: {exc}")
        return False, []


def save_etf_recommendation(user_id: int, etf_ticker: str, stock_ticker: str,
                             gps_score: float, predicted_change_pct: float,
                             confidence_score: float) -> bool:
    url = f"{INTERNAL_API_URL}/api/etf/holdings-recommendation"
    payload = {
        'user_id':             user_id,
        'etf_ticker':          etf_ticker,
        'stock_ticker':        stock_ticker,
        'gps_score':           round(gps_score, 1),
        'predicted_change_pct': round(predicted_change_pct, 2),
        'confidence_score':    round(confidence_score, 1),
        'source':              'etf_holdings_scan',
    }
    try:
        response = post_with_auth(url, payload)
        if response.ok:
            print(f"  [rec] ETF rec saved: {stock_ticker} in {etf_ticker} for user {user_id} "
                  f"(GPS {gps_score:.1f}, +{predicted_change_pct:.1f}%)")
            return True
        print(f"  [rec] WARNING: save rec returned {response.status_code} for "
              f"{stock_ticker} (user {user_id})")
        return False
    except Exception as exc:
        print(f"  [rec] ERROR saving rec for {stock_ticker}: {exc}")
        return False


def save_gps_score_to_db(cursor, ticker: str, gps_score: float, gps_breakdown: dict) -> bool:
    """Upsert GPS score into stock_gps_scores (global, not per-user).
    Mirrors what /api/prediction/save does after calling calculate_gps_v3.
    Auto-inserts the ticker into `stocks` if missing (e.g. ETF holdings the
    user doesn't own directly) so the GPS score actually persists for
    later /search/[ticker] / dashboard lookups instead of being silently
    dropped."""
    try:
        cursor.execute("SELECT id FROM stocks WHERE symbol = %s LIMIT 1", (ticker,))
        row = cursor.fetchone()
        if not row:
            # Insert with the ticker as company_name placeholder; a later
            # enrichment pass (deepmoney_sync, portfolio add, etc.) can
            # backfill the real name. Keeps the GPS write path unblocked.
            cursor.execute(
                "INSERT INTO stocks (symbol, company_name) VALUES (%s, %s)",
                (ticker, ticker)
            )
            stock_id = cursor.lastrowid
            print(f"  [gps-db] INSERTED {ticker} into stocks (was missing)")
        else:
            stock_id = row[0]
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        cursor.execute(
            """INSERT INTO stock_gps_scores
                   (stock_id, as_of, gps_score, gps_breakdown, source)
               VALUES (%s, %s, %s, %s, 'etf_holdings_scan')
               ON DUPLICATE KEY UPDATE
                   as_of         = VALUES(as_of),
                   gps_score     = VALUES(gps_score),
                   gps_breakdown = VALUES(gps_breakdown),
                   source        = VALUES(source)""",
            (stock_id, now, gps_score, json.dumps(gps_breakdown or {}))
        )
        return True
    except Exception as exc:
        print(f"  [gps-db] ERROR saving GPS for {ticker}: {exc}")
        return False


def run_prediction_for_holding(ticker: str,
                                prediction_cache: dict) -> dict | None:
    """Compute or retrieve a cached prediction result for an ETF holding ticker.
    Returns a dict with gps_score, predicted_change_pct, confidence_score, or None on failure.
    Populates the shared cache as a side-effect."""
    if ticker in prediction_cache:
        return prediction_cache[ticker]

    stock_data = fetch_stock_data(ticker)
    if not stock_data:
        prediction_cache[ticker] = _empty_cache_entry()
        return None

    historical = stock_data.get('historicalData', [])
    if len(historical) < 365:
        print(f"  [etf] SKIP {ticker}: only {len(historical)} days of history.")
        prediction_cache[ticker] = _empty_cache_entry()
        return None

    prediction_result = run_prediction(ticker, stock_data)
    if not prediction_result:
        prediction_cache[ticker] = _empty_cache_entry()
        return None

    pred_price_1m = prediction_result.get('predicted_price_1m')
    if pred_price_1m is None:
        pred_price_1m = prediction_result.get('predicted_price')
    predicted_price      = float(pred_price_1m) if pred_price_1m is not None else 0.0
    predicted_change_pct = float(prediction_result.get('predicted_change_pct', 0))
    confidence_score_val = float(prediction_result.get('confidence_score', 0))
    predicted_price_1w   = prediction_result.get('predicted_price_1w')
    predicted_price_6m   = prediction_result.get('predicted_price_6m')
    predicted_price_1y   = prediction_result.get('predicted_price_1y')

    sm = stock_data.get('stockMetrics', {})

    # Record to analytics prediction_records — mirrors the hot-stock path so
    # ETF holdings contribute to the same accuracy stats. Without this,
    # holdings predictions are computed and discarded for analytics purposes.
    price_at_prediction = sm.get('regularMarketPrice', predicted_price)
    if price_at_prediction and (predicted_price_1w or predicted_price or predicted_price_6m or predicted_price_1y):
        record_prediction(
            symbol=ticker,
            price_at_prediction=price_at_prediction,
            predicted_price_1w=predicted_price_1w,
            predicted_price_1m=predicted_price,
            predicted_price_6m=predicted_price_6m,
            predicted_price_1y=predicted_price_1y,
        )

    rec_key = (stock_data.get('recommendationKey')
               or sm.get('recommendationKey')
               or _recommendation_mean_to_key(sm.get('recommendationMean')))
    gps_inputs = {
        'predicted_change_pct': predicted_change_pct,
        'confidence_score':     confidence_score_val,
        'revenue_growth':       sm.get('revenueGrowth') or 0,
        'earnings_growth':      sm.get('earningsGrowth') or 0,
        'technical_score':      float(stock_data.get('technicalScore') or 0),
        'analyst_upside':       sm.get('analystUpside') or 0,
        'recommendation_key':   rec_key,
        'price_change_52w':     sm.get('fiftyTwoWeekChange') or 0,
    }
    gps_result = calculate_gps_v3(**gps_inputs)

    entry = {
        'predicted_price':      predicted_price,
        'predicted_price_1w':   predicted_price_1w,
        'predicted_price_6m':   predicted_price_6m,
        'predicted_price_1y':   predicted_price_1y,
        'predicted_change_pct': predicted_change_pct,
        'confidence_score':     confidence_score_val,
        'gps_score':            gps_result['score'],
        'gps_breakdown':        gps_result['breakdown'],
        'gps_inputs':           gps_inputs,
    }
    prediction_cache[ticker] = entry
    print(f"  [etf] {ticker}: GPS={entry['gps_score']}, pred={predicted_change_pct:.2f}%")
    return entry


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
    # prediction_cache: ticker → dict with raw prediction results + GPS inputs
    # (or all-None dict on failure). Keyed by ticker so the expensive model
    # runs once per stock; GPS is then computed per user using their strategy.
    prediction_cache: dict[str, dict] = {}

    # Batch fetch every user's strategy up front (defaults applied where missing)
    user_strategies = get_all_user_strategies(cursor, list(unique_users))

    stats = {'predicted': 0, 'cached': 0, 'saved': 0, 'skipped': 0, 'errors': 0}

    for row in rows:
        ticker  = row['ticker']
        user_id = row['user_id']
        strategy = user_strategies.get(user_id, DEFAULT_STRATEGY)

        print(f"\n→ user_id={user_id} ({row['username']})  ticker={ticker}  "
              f"strategy={strategy_bucket_key(strategy)}")

        # Check cache first (avoid re-running the model for shared stocks)
        if ticker in prediction_cache:
            cached = prediction_cache[ticker]
            predicted_price = cached['predicted_price']
            gps_score = cached.get('gps_score')
            gps_breakdown = cached.get('gps_breakdown')
            predicted_price_1w = cached.get('predicted_price_1w')
            predicted_price_6m = cached.get('predicted_price_6m')
            predicted_price_1y = cached.get('predicted_price_1y')
            predicted_change_pct_1w = cached.get('predicted_change_pct_1w')
            predicted_change_pct_1m = cached.get('predicted_change_pct_1m')
            predicted_change_pct_6m = cached.get('predicted_change_pct_6m')
            predicted_change_pct_1y = cached.get('predicted_change_pct_1y')
            confidence_score_1w = cached.get('confidence_score_1w')
            confidence_score_1m = cached.get('confidence_score_1m')
            confidence_score_6m = cached.get('confidence_score_6m')
            confidence_score_1y = cached.get('confidence_score_1y')
            print(f"  [cache] Using cached prediction for {ticker}: {predicted_price} (GPS: {gps_score})")
            stats['cached'] += 1
        else:
            # Fetch enriched data from the data endpoint
            stock_data = fetch_stock_data(ticker)
            if stock_data is None:
                prediction_cache[ticker] = _empty_cache_entry()
                stats['errors'] += 1
                continue

            # Validate minimum history depth (same gate as the API route: 365 rows)
            historical = stock_data.get('historicalData', [])
            if not historical or len(historical) < 365:
                print(f"  [data] SKIP {ticker}: only {len(historical)} days of history "
                      f"(minimum 365 required).")
                prediction_cache[ticker] = _empty_cache_entry()
                stats['skipped'] += 1
                continue

            # Run the prediction model
            prediction_result = run_prediction(ticker, stock_data)

            # Calculate GPS Score
            gps_score            = None
            predicted_price      = None
            gps_breakdown        = None
            predicted_change_pct = None
            confidence_score_val = None
            predicted_price_1w   = None
            predicted_price_6m   = None
            predicted_price_1y   = None
            predicted_change_pct_1w = None
            predicted_change_pct_1m = None
            predicted_change_pct_6m = None
            predicted_change_pct_1y = None
            confidence_score_1w = None
            confidence_score_1m = None
            confidence_score_6m = None
            confidence_score_1y = None

            gps_inputs = None

            if prediction_result is not None:
                stats['predicted'] += 1
                pred_price_1m = prediction_result.get('predicted_price_1m')
                if pred_price_1m is None:
                    pred_price_1m = prediction_result.get('predicted_price')
                predicted_price      = float(pred_price_1m) if pred_price_1m is not None else 0.0
                predicted_change_pct = float(prediction_result.get('predicted_change_pct', 0))
                confidence_score_val = float(prediction_result.get('confidence_score', 0))
                # Other-horizon prices — surfaced so the dashboard recommendations
                # route can pick the right column per the user's investment_timeframe.
                predicted_price_1w = prediction_result.get('predicted_price_1w')
                predicted_price_6m = prediction_result.get('predicted_price_6m')
                predicted_price_1y = prediction_result.get('predicted_price_1y')
                # Per-horizon change% and confidence — persisted so the dashboard
                # can recompute horizon-aware GPS identically to /api/prediction/[ticker]
                # instead of re-deriving from possibly-stale prices.
                def _f(v):
                    return float(v) if v is not None else None
                predicted_change_pct_1w = _f(prediction_result.get('predicted_change_pct_1w'))
                predicted_change_pct_1m = _f(prediction_result.get('predicted_change_pct_1m'))
                predicted_change_pct_6m = _f(prediction_result.get('predicted_change_pct_6m'))
                predicted_change_pct_1y = _f(prediction_result.get('predicted_change_pct_1y'))
                confidence_score_1w = _f(prediction_result.get('confidence_score_1w'))
                confidence_score_1m = _f(prediction_result.get('confidence_score_1m'))
                confidence_score_6m = _f(prediction_result.get('confidence_score_6m'))
                confidence_score_1y = _f(prediction_result.get('confidence_score_1y'))

                # GPS v3.0 — matches src/utils/gps.ts exactly
                sm = stock_data.get('stockMetrics', {})
                # Prefer top-level recommendationKey (set by /data since GPS fix);
                # fall back to converting recommendationMean for older cached payloads.
                rec_key = (stock_data.get('recommendationKey')
                           or sm.get('recommendationKey')
                           or _recommendation_mean_to_key(sm.get('recommendationMean')))
                gps_inputs = {
                    'predicted_change_pct': predicted_change_pct,
                    'confidence_score':     confidence_score_val,
                    'revenue_growth':       sm.get('revenueGrowth') or 0,
                    'earnings_growth':      sm.get('earningsGrowth') or 0,
                    'technical_score':      float(stock_data.get('technicalScore') or 0),
                    'analyst_upside':       sm.get('analystUpside') or 0,
                    'recommendation_key':   rec_key,
                    'price_change_52w':     sm.get('fiftyTwoWeekChange') or 0,
                }
                gps_result = calculate_gps_v3(**gps_inputs)
                gps_score     = gps_result['score']
                gps_breakdown = gps_result['breakdown']

                if gps_result['bearishSignal']:
                    print(f"  [gps] BEARISH SIGNAL for {ticker}: "
                          f"ML predicts {predicted_change_pct:.2f}% → GPS={gps_score}")
                print(f"  [gps] GPS v3.0 {ticker}: {gps_score}")

            else:
                stats['errors'] += 1

            prediction_cache[ticker] = {
                'predicted_price':      predicted_price,
                'predicted_price_1w':   predicted_price_1w,
                'predicted_price_6m':   predicted_price_6m,
                'predicted_price_1y':   predicted_price_1y,
                'predicted_change_pct': predicted_change_pct,
                'confidence_score':     confidence_score_val,
                'predicted_change_pct_1w': predicted_change_pct_1w,
                'predicted_change_pct_1m': predicted_change_pct_1m,
                'predicted_change_pct_6m': predicted_change_pct_6m,
                'predicted_change_pct_1y': predicted_change_pct_1y,
                'confidence_score_1w':     confidence_score_1w,
                'confidence_score_1m':     confidence_score_1m,
                'confidence_score_6m':     confidence_score_6m,
                'confidence_score_1y':     confidence_score_1y,
                'gps_score':            gps_score,
                'gps_breakdown':        gps_breakdown,
                'gps_inputs':           gps_inputs,
            }

        # Skip saving if the prediction failed
        if predicted_price is None:
            print(f"  [save] Skipping save for user {user_id} / {ticker} (no prediction).")
            continue

        # Save the prediction for this user.
        # - GPS goes to stock_gps_scores (one row per stock).
        # - All four predicted_price_* columns persist to user_stock_predictions so
        #   the dashboard recommendations route can pick the right horizon based on
        #   the user's investment_timeframe.
        saved = save_prediction(
            ticker, predicted_price, user_id, gps_score, gps_breakdown,
            predicted_price_1w=predicted_price_1w,
            predicted_price_6m=predicted_price_6m,
            predicted_price_1y=predicted_price_1y,
            predicted_change_pct_1w=predicted_change_pct_1w,
            predicted_change_pct_1m=predicted_change_pct_1m,
            predicted_change_pct_6m=predicted_change_pct_6m,
            predicted_change_pct_1y=predicted_change_pct_1y,
            confidence_score_1w=confidence_score_1w,
            confidence_score_1m=confidence_score_1m,
            confidence_score_6m=confidence_score_6m,
            confidence_score_1y=confidence_score_1y,
        )
        if saved:
            stats['saved'] += 1
        else:
            stats['errors'] += 1

        # Record to analytics prediction_records table (fire-and-forget)
        sm = stock_data.get('stockMetrics', {})
        price_at_prediction = sm.get('regularMarketPrice', predicted_price)
        if price_at_prediction and (predicted_price_1w or predicted_price or predicted_price_6m or predicted_price_1y):
            record_prediction(
                symbol=ticker,
                price_at_prediction=price_at_prediction,
                predicted_price_1w=predicted_price_1w,
                predicted_price_1m=predicted_price,
                predicted_price_6m=predicted_price_6m,
                predicted_price_1y=predicted_price_1y,
            )
 
    # --- ETF Holdings: scan each user's ETF positions for hot holdings --------
    # Baseline thresholds come from the ETF_HOLDING_ALGORITHM preset (same
    # source the Next.js routes use, so per-user strictness layers cleanly on
    # top of run-wide aggressiveness). ETF_HOLDING_MIN_CONFIDENCE remains an
    # independent env knob — it isn't part of the preset.
    _etf_preset        = resolve_etf_holding_algorithm()
    env_gps_threshold  = float(_etf_preset['gpsSurfaceValue'])
    env_pred_threshold = float(_etf_preset['minPredChangePct'])
    env_conf_threshold = float(os.getenv('ETF_HOLDING_MIN_CONFIDENCE', '60'))

    print(f"\n[ETF Holdings] Baseline thresholds (level={_etf_preset['level']:g}): "
          f"GPS≥{env_gps_threshold:g}, pred≥{env_pred_threshold:g}%, conf≥{env_conf_threshold:g}%")

    # ETF detection cache: ticker → (is_etf, [holding_tickers])
    etf_cache: dict[str, tuple[bool, list[str]]] = {}
    etf_recs_saved = 0

    # Group rows by user so we process each user's ETF set once
    user_rows: dict[int, list[dict]] = {}
    for row in rows:
        user_rows.setdefault(row['user_id'], []).append(row)

    for user_id, user_row_list in user_rows.items():
        username = user_row_list[0]['username']
        user_etfs_processed = set()

        # Resolve per-user gates (the strictest of env baseline and strategy)
        user_strategy = user_strategies.get(user_id, DEFAULT_STRATEGY)
        resolved = resolve_strategy(user_strategy)
        gates    = resolved['gates']
        mult     = gates['envFloorMultiplier']
        # Scale env baselines by the user's aggressiveness multiplier
        # (safe=1.05, neutral=1.0, aggressive=0.95). predChangeGate floors at
        # the strategy's own absolute value (safe=3%, neutral=1.5%, aggressive=0.5%).
        gps_threshold  = env_gps_threshold  * mult
        pred_threshold = max(env_pred_threshold * mult, gates['predChangeGate'])
        conf_threshold = env_conf_threshold * mult
        print(f"\n  [etf] user_id={user_id} strategy={strategy_bucket_key(user_strategy)} "
              f"mult={mult} "
              f"gates: GPS≥{gps_threshold:.1f}, pred≥{pred_threshold:.1f}%, conf≥{conf_threshold:.1f}%")

        for row in user_row_list:
            ticker = row['ticker']

            if ticker in user_etfs_processed:
                continue

            # Detect ETF (cached)
            if ticker not in etf_cache:
                print(f"\n  [etf] Checking {ticker} for ETF holdings...")
                etf_cache[ticker] = fetch_etf_holdings(ticker)
            is_etf, holding_tickers = etf_cache[ticker]

            if not is_etf or not holding_tickers:
                continue

            user_etfs_processed.add(ticker)
            print(f"\n  [etf] user_id={user_id} ({username}) holds ETF {ticker} "
                  f"— scanning {len(holding_tickers)} holding(s)")

            for holding_ticker in holding_tickers:
                result = run_prediction_for_holding(holding_ticker, prediction_cache)
                if not result:
                    continue

                # GPS is strategy-independent now; just read what was already computed.
                gps       = result.get('gps_score')
                breakdown = result.get('gps_breakdown') or {}
                pred      = result.get('predicted_change_pct')
                conf      = result.get('confidence_score')

                if gps is None or pred is None or conf is None:
                    continue

                # Persist GPS score to stock_gps_scores (global, feeds /search/[ticker])
                save_gps_score_to_db(cursor, holding_ticker, gps, breakdown)

                # Save recommendation if all hot thresholds are met
                if gps >= gps_threshold and pred >= pred_threshold and conf >= conf_threshold:
                    saved = save_etf_recommendation(user_id, ticker, holding_ticker, gps, pred, conf)
                    if saved:
                        etf_recs_saved += 1

    print(f"\n[ETF Holdings] Recommendations generated: {etf_recs_saved}")

    # --- Build the dashboard-card preview BEFORE closing the connection.
    # This replicates the /api/dashboard/recommendations filter logic so the
    # summary table reflects what users actually see on /dashboard, not just
    # what we wrote to user_stock_predictions. Macro adjustment (±3 GPS pts)
    # is omitted for simplicity — the table is otherwise faithful.
    conn.commit()
    dashboard_cards = _build_dashboard_card_preview(cursor, list(unique_users))

    # --- Wrap up ---------------------------------------------------------
    cursor.close()
    conn.close()

    print(f"\n[{datetime.now()}] Sync complete.")
    print(f"  Predictions run  : {stats['predicted']}")
    print(f"  Served from cache: {stats['cached']}")
    print(f"  Saves successful : {stats['saved']}")
    print(f"  Skipped (history): {stats['skipped']}")
    print(f"  Errors           : {stats['errors']}")
    print(f"  ETF recs saved   : {etf_recs_saved}")

    _print_dashboard_qualified_table(dashboard_cards)


# Mirrors src/utils/strategy.ts so the summary table can apply the same
# gates/thresholds the dashboard's read path uses. Keep in sync when the TS
# constants drift. (Aggressiveness-only strategy_config.py doesn't carry
# investment_timeframe, so we read it directly from user_investment_strategy.)
_DASHBOARD_STRATEGY_GATES = {
    'safe':       {'predChangeGate': 3.0, 'envFloorMultiplier': 1.05},
    'neutral':    {'predChangeGate': 1.5, 'envFloorMultiplier': 1.0},
    'aggressive': {'predChangeGate': 0.5, 'envFloorMultiplier': 0.95},
}
_DASHBOARD_TIMEFRAME_CONFIG = {
    '1_week':  {'predChangeMultiplier': 0.5, 'sellThresholdShift': -2, 'col_sfx': '1w'},
    '1_month': {'predChangeMultiplier': 1.0, 'sellThresholdShift':  0, 'col_sfx': '1m'},
    '6_month': {'predChangeMultiplier': 1.5, 'sellThresholdShift':  3, 'col_sfx': '6m'},
    '1_year':  {'predChangeMultiplier': 2.0, 'sellThresholdShift':  5, 'col_sfx': '1y'},
}


def _adjust_gps_for_horizon(breakdown: dict, change_pct: float, confidence: float | None) -> float:
    """Mirror src/utils/gps.ts adjustGpsForHorizon. Patches the two
    horizon-dependent components (mlpUpside + mlpConfidence) using the
    user's per-horizon predicted change% + confidence, then sums."""
    prediction_max = float(os.getenv('GPS_PREDICTION_MAX', '3'))
    new_mlp_upside = max(-1.0, min(1.0, change_pct / prediction_max)) * 20.0
    if confidence is not None:
        new_mlp_confidence = (max(0.0, min(100.0, confidence)) / 100.0) * 5.0
    else:
        new_mlp_confidence = float(breakdown.get('mlpConfidence', 0) or 0)
    total = (
        round(new_mlp_upside, 1)
        + round(new_mlp_confidence, 1)
        + float(breakdown.get('revenueGrowth', 0) or 0)
        + float(breakdown.get('earningsGrowth', 0) or 0)
        + float(breakdown.get('technicalSignal', 0) or 0)
        + float(breakdown.get('analystUpside', 0) or 0)
        + float(breakdown.get('analystConsensus', 0) or 0)
        + float(breakdown.get('priceChange52w', 0) or breakdown.get('fiftyTwoWeekChange', 0) or 0)
    )
    return round(max(0.0, min(100.0, total)), 1)


def _fetch_live_prices_batch(tickers: list[str]) -> dict[str, float]:
    """Fetch the latest live price for each ticker via yfinance's fast_info
    endpoint. Matches what fetchYahooQuotesForSymbols gives the dashboard
    (`yahooFinance.quote(...)`). Per-ticker because batched yf.download with
    period='1d' silently drops tickers for non-trading-day edge cases and
    .KS/.HK listings. fast_info is the right realtime endpoint, equivalent
    to the TS-side quote() call. Missing tickers are silently omitted —
    the caller drops the card, matching the dashboard's behavior."""
    if not tickers:
        return {}
    out: dict[str, float] = {}
    missing: list[str] = []
    for t in tickers:
        try:
            fi = yf.Ticker(t).fast_info
            # fast_info exposes last_price (snake_case attr) or 'lastPrice' (dict-style key).
            price = None
            try:
                price = fi.last_price
            except AttributeError:
                pass
            if price is None:
                try:
                    price = fi['lastPrice']
                except (KeyError, TypeError):
                    pass
            if price is None or not (price > 0):
                missing.append(t)
                continue
            out[t] = float(price)
        except Exception:
            missing.append(t)
            continue
    if missing:
        print(f"  [preview] No live price for: {', '.join(missing)}")
    return out


def _build_dashboard_card_preview(cursor, user_ids: list[int]) -> list[dict]:
    """Re-query the DB and apply the same logic as
    src/app/api/dashboard/recommendations/route.ts so the summary table at
    the end of the sync reflects what each user will actually see on their
    dashboard. Returns one card per (user_id, ticker) that would render.

    Uses live current prices (batch-fetched from Yahoo) for the deltaPct
    gate so the answer matches the dashboard exactly. Macro adjustment
    (±3 GPS pts) is still omitted — flagged in the footer note."""
    if not user_ids:
        return []

    placeholders = ','.join(['%s'] * len(user_ids))
    cards: list[dict] = []

    # Env-driven dashboard thresholds (defaults match the TS route).
    env_buy_threshold       = float(os.getenv('GPS_BASELINE',           '65'))
    env_sell_threshold      = env_buy_threshold + float(os.getenv('GPS_SELL_OFFSET',      '-20'))
    env_discovery_threshold = env_buy_threshold + float(os.getenv('GPS_DISCOVERY_OFFSET', '5'))

    # ── Portfolio / watchlist / discovery candidates ────────────────────────
    cursor.execute(f"""
        SELECT usp.user_id, s.symbol,
               us.is_purchased, us.user_confirmed, us.shares,
               usp.predicted_price_1w, usp.predicted_price_1m,
               usp.predicted_price_6m, usp.predicted_price_1y,
               usp.predicted_change_pct_1w, usp.predicted_change_pct_1m,
               usp.predicted_change_pct_6m, usp.predicted_change_pct_1y,
               usp.confidence_score_1w, usp.confidence_score_1m,
               usp.confidence_score_6m, usp.confidence_score_1y,
               sgs.gps_score, sgs.gps_breakdown,
               uis.aggressiveness, uis.investment_timeframe
        FROM user_stock_predictions usp
        JOIN user_stocks us ON us.user_id = usp.user_id AND us.stock_id = usp.stock_id
        JOIN stocks s ON s.id = usp.stock_id
        LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
        LEFT JOIN user_investment_strategy uis ON uis.user_id = usp.user_id
        WHERE usp.user_id IN ({placeholders}) AND us.is_active = 1
    """, list(user_ids))
    rows = cursor.fetchall()

    # ── ETF holding candidates from the latest per-user snapshot ────────────
    cursor.execute(f"""
        SELECT esr.user_id, esr.stock_ticker, esr.etf_ticker, esr.gps_score, esr.predicted_change_pct
        FROM etf_stock_recommendations esr
        WHERE esr.user_id IN ({placeholders})
          AND esr.snapshot_date = (
            SELECT MAX(snapshot_date) FROM etf_stock_recommendations WHERE user_id = esr.user_id
          )
    """, list(user_ids))
    etf_rows = cursor.fetchall()

    # Batch fetch live prices for every unique ticker we might need to score.
    # The dashboard route uses fetchYahooQuotesForSymbols for this exact set.
    all_tickers = {r[1] for r in rows} | {r[1] for r in etf_rows}
    print(f"\n  [preview] Fetching live prices for {len(all_tickers)} unique ticker(s)...")
    live_prices = _fetch_live_prices_batch(sorted(all_tickers))
    print(f"  [preview] Got live prices for {len(live_prices)}/{len(all_tickers)} ticker(s).")

    for r in rows:
        (user_id, symbol, is_purchased, user_confirmed, shares,
         pp1w, pp1m, pp6m, pp1y,
         pc1w, pc1m, pc6m, pc1y,
         cs1w, cs1m, cs6m, cs1y,
         sgs_gps, sgs_breakdown,
         aggressiveness, timeframe) = r

        gates  = _DASHBOARD_STRATEGY_GATES.get(aggressiveness or 'neutral', _DASHBOARD_STRATEGY_GATES['neutral'])
        tf_cfg = _DASHBOARD_TIMEFRAME_CONFIG.get(timeframe or '1_month',     _DASHBOARD_TIMEFRAME_CONFIG['1_month'])
        sfx    = tf_cfg['col_sfx']
        mult   = gates['envFloorMultiplier']
        buy_threshold       = env_buy_threshold       * mult
        sell_threshold      = env_sell_threshold      + tf_cfg['sellThresholdShift']
        discovery_threshold = env_discovery_threshold * mult
        pred_change_gate    = gates['predChangeGate'] * tf_cfg['predChangeMultiplier']

        # Mirror the dashboard route exactly: predictedPrice =
        # COALESCE(predicted_price_{horizon}, predicted_price_1m); deltaPct
        # uses the LIVE current price.
        price_by_sfx       = {'1w': pp1w, '1m': pp1m, '6m': pp6m, '1y': pp1y}
        change_pct_by_sfx  = {'1w': pc1w, '1m': pc1m, '6m': pc6m, '1y': pc1y}
        confidence_by_sfx  = {'1w': cs1w, '1m': cs1m, '6m': cs6m, '1y': cs1y}

        predicted_price = price_by_sfx[sfx] if price_by_sfx[sfx] is not None else price_by_sfx['1m']
        current_price = live_prices.get(symbol)
        if predicted_price is None or current_price is None or current_price <= 0:
            continue  # matches the dashboard's `if (!quote || quote.price === null) continue`
        predicted_price_f = float(predicted_price)
        delta_pct = ((predicted_price_f - current_price) / current_price) * 100.0

        # storedChangePct is preferred for the GPS adjustment (matches model's
        # baked-in horizon view); falls back to live deltaPct when null.
        stored_change_pct = change_pct_by_sfx[sfx]
        change_pct_for_adjust = float(stored_change_pct) if stored_change_pct is not None else delta_pct
        confidence = confidence_by_sfx[sfx]
        confidence_f = float(confidence) if confidence is not None else None

        # Adjust GPS using the per-horizon change% (matches the dashboard).
        if sgs_breakdown is not None:
            try:
                breakdown = json.loads(sgs_breakdown) if isinstance(sgs_breakdown, (str, bytes, bytearray)) else sgs_breakdown
                adjusted_gps = _adjust_gps_for_horizon(breakdown, change_pct_for_adjust, confidence_f)
            except Exception:
                adjusted_gps = float(sgs_gps) if sgs_gps is not None else None
        else:
            adjusted_gps = float(sgs_gps) if sgs_gps is not None else None
        if adjusted_gps is None:
            continue

        passes_pred_gate = delta_pct >= pred_change_gate
        is_purch  = is_purchased == 1
        is_conf   = user_confirmed == 1
        has_shares = (shares or 0) > 0

        action = None
        scope  = None
        if is_purch and is_conf and has_shares:
            scope = 'portfolio'
            if adjusted_gps >= buy_threshold and passes_pred_gate:
                action = 'BUY'
            elif adjusted_gps < sell_threshold:
                action = 'SELL'
        elif not is_purch and is_conf:
            scope = 'watchlist'
            if adjusted_gps >= buy_threshold and passes_pred_gate:
                action = 'BUY'
        elif not is_purch and not is_conf:
            scope = 'discovery'
            if adjusted_gps >= discovery_threshold and passes_pred_gate:
                action = 'BUY'

        if action and scope:
            cards.append({
                'user_id':  user_id,
                'ticker':   symbol,
                'action':   action,
                'scope':    scope,
                'gps':      adjusted_gps,
                'pred_pct': delta_pct,
            })

    # ETF holding dedup against portfolio/watchlist/discovery cards
    existing_keys = {(c['user_id'], c['ticker']) for c in cards}
    etf_dedup: dict[tuple[int, str], dict] = {}
    for er in etf_rows:
        uid, symbol, parent_etf, gps, pred = er
        if gps is None: continue
        key = (uid, symbol)
        if key in existing_keys:
            continue
        gps_f  = float(gps)
        pred_f = float(pred) if pred is not None else 0.0
        if key not in etf_dedup or gps_f > etf_dedup[key]['gps']:
            etf_dedup[key] = {
                'user_id':    uid,
                'ticker':     symbol,
                'action':     'BUY',
                'scope':      'etf_holding',
                'gps':        gps_f,
                'pred_pct':   pred_f,
                'parent_etf': parent_etf,
            }
    cards.extend(etf_dedup.values())
    return cards


def _print_dashboard_qualified_table(cards: list[dict]) -> None:
    """Deduplicate the per-user card list by ticker and print a single
    summary table — what's about to render on user dashboards, sorted by
    GPS desc (BR-8.6 ordering)."""
    if not cards:
        return

    # Aggregate per ticker — keep the highest-GPS card as the representative,
    # but remember every distinct user_id so we can report reach.
    agg: dict[str, dict] = {}
    for c in cards:
        key = c['ticker']
        if key not in agg or c['gps'] > agg[key]['gps']:
            prev_users = agg[key]['users'] if key in agg else set()
            agg[key] = {
                'ticker':   c['ticker'],
                'action':   c['action'],
                'scope':    c['scope'],
                'gps':      c['gps'],
                'pred_pct': c['pred_pct'],
                'users':    prev_users | {c['user_id']},
                'detail':   c.get('parent_etf', ''),
            }
        else:
            agg[key]['users'].add(c['user_id'])

    sorted_rows = sorted(agg.values(), key=lambda x: x['gps'], reverse=True)

    print()
    print("=" * 86)
    print(f"  DASHBOARD-QUALIFIED STOCKS ({len(sorted_rows)})  — what users will see on /dashboard")
    print("=" * 86)
    print(f"  {'TICKER':<10}  {'ACT':<4}  {'SCOPE':<11}  {'GPS':>6}  {'PRED':>7}  {'USERS':>5}  DETAIL")
    print(f"  {'-'*10}  {'-'*4}  {'-'*11}  {'-'*6}  {'-'*7}  {'-'*5}  {'-'*22}")
    for r in sorted_rows:
        ticker   = str(r['ticker'])[:10]
        action   = str(r['action'])[:4]
        scope    = str(r['scope'])[:11]
        gps      = r['gps']
        pred_pct = r['pred_pct']
        users    = len(r['users'])
        detail   = (f"in {r['detail']}" if r.get('detail') else '')[:22]
        print(f"  {ticker:<10}  {action:<4}  {scope:<11}  {gps:>6.1f}  {pred_pct:>+6.2f}%  {users:>5}  {detail}")
    print("=" * 86)
    print("  Note: macro GPS adjustment (±3 pts) is not applied to this preview.")


if __name__ == "__main__":
    sync_portfolio_predictions()