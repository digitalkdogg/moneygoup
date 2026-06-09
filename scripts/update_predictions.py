import json
import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv
from strategy_config import (
    DEFAULT_STRATEGY,
    resolve_strategy,
    get_all_user_strategies,
    strategy_bucket_key,
)  # aggressiveness-only after the timeframe removal

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
def save_prediction(
    ticker: str,
    predicted_price: float,
    user_id: int,
    gps_score: float = None,
    gps_breakdown: dict = None,
) -> bool:
    """Persist a prediction. GPS goes to stock_gps_scores (one row per stock)."""
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
# Helpers for prediction cache
# ---------------------------------------------------------------------------
def _empty_cache_entry() -> dict:
    return {
        'predicted_price':      None,
        'predicted_change_pct': None,
        'confidence_score':     None,
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
    Mirrors what /api/prediction/save does after calling calculate_gps_v3."""
    try:
        cursor.execute("SELECT id FROM stocks WHERE symbol = %s LIMIT 1", (ticker,))
        row = cursor.fetchone()
        if not row:
            print(f"  [gps-db] SKIP {ticker}: not found in stocks table")
            return False
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

    predicted_price      = float(prediction_result.get('predicted_price_1m', 0))
    predicted_change_pct = float(prediction_result.get('predicted_change_pct', 0))
    confidence_score_val = float(prediction_result.get('confidence_score', 0))

    sm = stock_data.get('stockMetrics', {})
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

            gps_inputs = None

            if prediction_result is not None:
                stats['predicted'] += 1
                predicted_price      = float(prediction_result.get('predicted_price_1m', 0))
                predicted_change_pct = float(prediction_result.get('predicted_change_pct', 0))
                confidence_score_val = float(prediction_result.get('confidence_score', 0))

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
                'predicted_change_pct': predicted_change_pct,
                'confidence_score':     confidence_score_val,
                'gps_score':            gps_score,
                'gps_breakdown':        gps_breakdown,
                'gps_inputs':           gps_inputs,
            }

        # Skip saving if the prediction failed
        if predicted_price is None:
            print(f"  [save] Skipping save for user {user_id} / {ticker} (no prediction).")
            continue

        # Save the prediction for this user. GPS goes to stock_gps_scores (one row per stock).
        saved = save_prediction(ticker, predicted_price, user_id, gps_score, gps_breakdown)
        if saved:
            stats['saved'] += 1
        else:
            stats['errors'] += 1
 
    # --- ETF Holdings: scan each user's ETF positions for hot holdings --------
    # Env-var thresholds are the baseline; each user's strategy can tighten/loosen
    # them via the gates resolved from their (timeframe, aggressiveness).
    env_gps_threshold  = float(os.getenv('ETF_HOLDING_GPS_SURFACE_VALUE', '60'))
    env_pred_threshold = float(os.getenv('ETF_HOLDING_MIN_PRED_CHANGE',   '1.5'))
    env_conf_threshold = float(os.getenv('ETF_HOLDING_MIN_CONFIDENCE',    '60'))

    print(f"\n[ETF Holdings] Baseline thresholds: "
          f"GPS≥{env_gps_threshold}, pred≥{env_pred_threshold}%, conf≥{env_conf_threshold}%")

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

    # --- Wrap up ---------------------------------------------------------
    conn.commit()  # flush direct GPS writes from ETF holdings scan
    cursor.close()
    conn.close()

    print(f"\n[{datetime.now()}] Sync complete.")
    print(f"  Predictions run  : {stats['predicted']}")
    print(f"  Served from cache: {stats['cached']}")
    print(f"  Saves successful : {stats['saved']}")
    print(f"  Skipped (history): {stats['skipped']}")
    print(f"  Errors           : {stats['errors']}")
    print(f"  ETF recs saved   : {etf_recs_saved}")
 
 
if __name__ == "__main__":
    sync_portfolio_predictions()