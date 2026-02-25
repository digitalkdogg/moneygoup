1. Executive Summary
This document specifies the full technical implementation required to upgrade the stock price prediction feature from its current Gradient Boosting Regressor (GBR) design to a TensorFlow LSTM architecture with dual 6-month and 12-month forecast horizons.

The single most important architectural constraint governing this work is:

CONSTRAINT: All data gathering must happen on the Next.js side. The Python prediction script must receive a fully pre-assembled data payload and must never make outbound network calls of its own.

This means the existing predict_weighted_analysis.py must be refactored into a pure ML script. A new Python data-fetching script (fetch_stock_data.py) and a new Next.js API route (GET /api/stock/[ticker]/data) are responsible for all yfinance calls.

The end result is a clean two-step flow triggered by a single button click in the UI:

    • Step 1 — Data fetch: Next.js calls GET /api/stock/[ticker]/data, which spawns fetch_stock_data.py to pull 5 years of OHLCV, all fundamentals, analyst consensus targets, and macro proxy data from yfinance.
    • Step 2 — Prediction: Next.js calls POST /api/stock/[ticker]/predict/tensorflow with the pre-fetched payload. The Python ML script runs the LSTM model and returns dual-horizon predictions. No network calls are made by the script.

2. Architecture Overview
2.1  Current Architecture (v1.0)
The current system has a single code path:

Browser  →  POST /api/stock/[ticker]/predict/tensorflow
              →  predict_weighted_analysis.py <ticker> --input_file <path>
                    • receives 1 year of close-only historical data
                    • runs GradientBoostingRegressor
                    • returns single predicted_change_range

Problems with this design:
    • Only 1 year (~252 rows) of price history is passed — insufficient for LSTM training on meaningful market cycles.
    • The Python prediction script is responsible for data shaping but receives impoverished inputs (no open/high/low, no analyst targets, no macro data).
    • Fundamental metrics are zero-imputed when missing, distorting model features.
    • There is no separation between data concerns and ML concerns.

2.2  New Architecture (v2.0)
The new system separates data gathering and prediction into two explicit phases:

Browser  →  Step 1: GET /api/stock/[ticker]/data            (NEW route)
              →  fetch_stock_data.py <ticker>               (NEW script)
                    • yfinance: 5yr OHLCV (open/high/low/close/volume)
                    • yfinance: all fundamentals from ticker.info
                    • yfinance: analyst consensus targets
                    • yfinance: macro proxies (^VIX, ^TNX, sector ETF)
                    • yfinance: quarterly earnings history
                    • returns enriched JSON payload to route
              ←  returns enriched payload to browser

Browser  →  Step 2: POST /api/stock/[ticker]/predict/tensorflow  (UPDATED route)
              body = { historicalData, stockMetrics, macroData,
                       newsArticles, historicalEarnings, dataQuality }
              →  predict_weighted_analysis.py <ticker> --input_file <path>
                    • reads pre-fetched payload from file
                    • runs TensorFlow LSTM model
                    • NO outbound network calls
                    • returns dual-horizon prediction JSON

IMPORTANT: The browser holds the complete data payload between step 1 and step 2. This is intentional — it keeps the data-fetch layer cacheable and the prediction layer stateless.

2.3  File Deliverables
File
Action
Location
Description
fetch_stock_data.py
CREATE
project root (alongside predict_weighted_analysis.py)
New Python script. Fetches all data from yfinance. Pure data — no ML.
data/route.ts
CREATE
src/app/api/stock/[ticker]/data/route.ts
New Next.js GET route. Spawns fetch_stock_data.py. Includes 5-minute server cache.
predict/tensorflow/route.ts
REPLACE
src/app/api/stock/[ticker]/predict/tensorflow/route.ts
Updated POST route. Validates pre-fetched payload. Spawns ML script. No data fetching.
predict_weighted_analysis.py
REFACTOR
project root
Existing ML script. Remove any yfinance calls. Add LSTM model. Consume enriched payload fields.
StockPrediction.tsx
REPLACE
src/components/StockPrediction.tsx (or equivalent)
Updated component. Two-step fetch+predict flow. Dual-horizon cards, trajectory chart, confidence badges.


3. fetch_stock_data.py — New Data Fetching Script
This is a brand-new Python script. It is the only script in the project that is permitted to call yfinance. Its sole responsibility is to fetch, validate, and return a complete data payload for a given ticker.

3.1  CLI Interface
Command
python3 fetch_stock_data.py <TICKER>
Arguments
ticker (positional, required) — uppercase stock symbol e.g. AAPL
Stdout
Single JSON object (see Section 3.3 Output Schema)
Stderr
WARN: messages for imputed fields, failed macro fetches. ERROR: JSON on fatal failure.
Exit 0
Success — valid JSON on stdout
Exit 1
Failure — error JSON on stderr, nothing on stdout

3.2  yfinance Calls Required
All data comes from yfinance. No other data source is used. The following calls must be made for each ticker:

Call
yfinance Method
Key Fields
Purpose
OHLCV history
ticker.history(period='5y', interval='1d')
Open, High, Low, Close, Volume
5 years of daily price bars (~1,260 rows)
Fundamentals
ticker.info
trailingPE, priceToBook, trailingEps, forwardEps, revenueGrowth, earningsGrowth, profitMargins, freeCashflow, debtToEquity, returnOnEquity, dividendYield, beta, sector, marketCap
Core valuation and growth metrics
Analyst targets
ticker.info (same call)
targetMeanPrice, targetMedianPrice, targetHighPrice, targetLowPrice, numberOfAnalystOpinions, recommendationMean
Wall Street consensus — no additional API call needed
VIX
yf.Ticker('^VIX').history(period='5y')
Close
Market fear/volatility index
10Y Treasury
yf.Ticker('^TNX').history(period='5y')
Close
Risk-free rate proxy, equity valuation driver
Sector ETF
yf.Ticker('<ETF>').history(period='5y')
Close
Sector relative strength. ETF chosen by sector string from ticker.info.
Earnings history
ticker.earnings_dates + ticker.quarterly_income_stmt
Reported EPS, EPS Estimate, Total Revenue, Net Income
EPS beat/miss streak, revenue trend

EFFICIENCY: ticker.info is a single HTTP call that returns all fundamental AND analyst target fields simultaneously. Do not make separate calls for analyst targets — they are already in the info dict.

3.3  Sector ETF Mapping
Use ticker.info['sector'] to look up the appropriate sector ETF. If the sector is unknown or not in the map, default to SPY (S&P 500).

Sector (from ticker.info)
ETF Ticker
Technology
XLK
Healthcare
XLV
Financials / Financial Services
XLF
Consumer Cyclical
XLY
Consumer Defensive
XLP
Industrials
XLI
Energy
XLE
Utilities
XLU
Real Estate
XLRE
Basic Materials / Materials
XLB
Communication Services
XLC
Unknown / default
SPY

3.4  Missing Value Handling — Sector Median Imputation
CONSTRAINT: Never impute a missing fundamental value as 0. A PE ratio of 0 tells the model the company has no earnings, which is false and misleads the LSTM. Use sector medians instead.

When ticker.info returns None or 0 for a fundamental field, substitute the sector median from the table below. Log every imputed field to stderr as: WARN: {field} missing for {ticker}, imputed sector median {value}. Also record imputed field names in the dataQuality.imputedFields array.

Sector
PE Ratio
PB Ratio
Profit Margin
Revenue Growth
Debt/Equity
ROE
Technology
28.0
6.0
20%
10%
50
25%
Healthcare
22.0
4.0
12%
7%
60
15%
Financials
12.0
1.2
20%
5%
200
12%
Consumer Cyclical
20.0
3.5
7%
6%
80
18%
Consumer Defensive
18.0
3.0
8%
4%
70
15%
Industrials
18.0
3.0
9%
6%
90
16%
Energy
12.0
1.8
10%
4%
50
12%
Utilities
16.0
1.5
12%
3%
120
10%
Real Estate
30.0
2.0
25%
5%
100
8%
Communication Services
20.0
3.5
15%
7%
70
18%
Default (unknown)
20.0
3.0
12%
6%
75
15%

3.5  History Depth Requirements
Preferred depth
5 years (period="5y") — approximately 1,260 trading days. Always attempt this first.
Minimum accepted
2 years (504 trading days). If fewer than 504 rows are returned, exit with error code 1 and a user-readable error message: "Insufficient history for {ticker}: {n} days available, minimum 504 required."
Warning threshold
If between 504 and 1,259 days are available, include a warning in dataQuality and surface it in the UI. Do not abort — proceed with available data.
Recent IPOs
Some tickers will not have 2 years of history. This is expected. Return a clear error so the UI can display a meaningful message to the user.

3.6  Output JSON Schema
The script must print exactly this JSON structure to stdout on success. All field names are case-sensitive.

{
  "ticker": "AAPL",
  "historicalData": [
    { "date": "2020-01-02", "open": 296.24, "high": 300.60,
      "low": 295.19, "close": 300.35, "volume": 33870100 },
    ...  // ~1,260 rows for a 5-year fetch
  ],
  "stockMetrics": {
    "peRatio": 28.5,           "pbRatio": 6.2,
    "marketCap": 2800000000000,"trailingEps": 6.43,
    "forwardEps": 7.12,        "revenueGrowth": 0.082,
    "earningsGrowth": 0.11,    "profitMargins": 0.245,
    "freeCashflow": 99584000000,"debtToEquity": 151.86,
    "returnOnEquity": 1.474,   "dividendYield": 0.0056,
    "beta": 1.24,              "sector": "Technology",
    "analystTargetMean": 215.0, "analystTargetMedian": 220.0,
    "analystTargetHigh": 260.0, "analystTargetLow": 170.0,
    "analystOpinionCount": 38,  "recommendationMean": 1.8
  },
  "macroData": {
    "vix":         [{ "date": "2020-01-02", "close": 13.77 }, ...],
    "treasury10y": [{ "date": "2020-01-02", "close": 1.88  }, ...],
    "sectorEtf":   { "ticker": "XLK",
                    "data": [{ "date": "2020-01-02", "close": 91.34 }, ...] }
  },
  "historicalEarnings": [
    { "date": "2024-02-01", "epsActual": 2.18, "epsEstimate": 2.10,
      "revenue": 119575000000, "earnings": 33916000000 },
    ...  // sorted descending (most recent first)
  ],
  "dataQuality": {
    "historyDays": 1258,
    "historyYears": 4.99,
    "fundamentalsComplete": true,
    "analystDataAvailable": true,
    "macroDataAvailable": true,
    "imputedFields": []   // list of field names that were sector-median imputed
  }
}


4. GET /api/stock/[ticker]/data — New Next.js Route
This is a brand-new API route. It is the only Next.js endpoint that may spawn fetch_stock_data.py. Its job is to authenticate the request, spawn the data-fetch script, cache the result, and return the enriched payload to the client.

4.1  Route Specification
File path
src/app/api/stock/[ticker]/data/route.ts
Method
GET
URL pattern
/api/stock/[ticker]/data
Auth
getServerSession(authOptions) — same pattern as existing predict route. Return 401 if no session.
Origin check
checkOrigin(request) — same pattern as existing predict route.
Ticker validation
tickerSchema.parse(params.ticker) via Zod — same schema as existing predict route.
Success response
HTTP 200 with the JSON object from fetch_stock_data.py stdout.
Error responses
HTTP 400 for invalid ticker, 401 for unauthenticated, 500 for script failure. Error body: { message: string }.

4.2  Server-Side Cache
Fetching 5 years of OHLCV plus three macro series takes 4-8 seconds. A server-side in-memory cache prevents redundant fetches when multiple users view the same ticker within a short window.

Cache type
In-process Map<string, { data: unknown; fetchedAt: number }>
Cache key
validatedTicker (uppercase, e.g. "AAPL")
TTL
5 minutes (300,000 ms). Return cached data if age < TTL.
Eviction
Lazy eviction on every write — iterate and delete entries older than TTL. Same pattern as the existing tickerCooldown map in the predict route.
Hard cap
If map grows beyond 500 entries after eviction, clear the entire map and log a warning.
Cache scope
Per-server-process only. Not shared across serverless instances. This is acceptable — a cache miss just triggers a fresh fetch.

4.3  Python Process Handling
Use the same spawn pattern as the existing predict route. Key details:
    • Command: python3 fetch_stock_data.py <ticker>
    • cwd: process.cwd() — the project root where the script lives.
    • Capture stdout (JSON result) and stderr (warnings/errors) separately.
    • On non-zero exit code, try to parse stderr as JSON to extract a user-readable error.message. Fall back to a generic error if stderr is not valid JSON.
    • No temp file needed — unlike the predict script, fetch_stock_data.py takes the ticker as a CLI arg, not a file.

5. POST /api/stock/[ticker]/predict/tensorflow — Updated Route
This route replaces the existing predict route. The core logic (rate limiting, semaphore, temp file, process spawn) is unchanged. The key differences are:

    • The route no longer fetches data. It receives a complete pre-fetched payload in the request body.
    • Payload validation is expanded to enforce the minimum history depth (504 rows) before acquiring the semaphore.
    • The body shape changes to include the new fields (macroData, dataQuality, enriched stockMetrics).

5.1  Request Body Schema
The request body must match the output of fetch_stock_data.py exactly (see Section 3.6). The route adds newsArticles (client-side sentiment data) before forwarding to the script.

historicalData
Required. Array of OHLCV objects. Minimum 504 rows. Each row: { date, open, high, low, close, volume }.
stockMetrics
Required. Object with all fundamental and analyst fields from Section 3.6. No field may be absent — use null for unavailable values.
macroData
Required. Object with vix, treasury10y, sectorEtf arrays. Arrays may be empty if the macro fetch failed, but the key must be present.
newsArticles
Required (may be empty array). Added by the client from its own news fetch. Shape: [{ title, sentiment_score, publishedAt?, article_type? }].
historicalEarnings
Required (may be empty array). Sourced from the /data response, not the client props.
dataQuality
Required. Object from fetch_stock_data.py. Passed through to the Python ML script for use in confidence score calculation.

5.2  Validation Rules
Check
Condition
Response
Auth
No session
HTTP 401
Ticker format
Fails tickerSchema
HTTP 400 with validation message
Rate limit
Within 30s cooldown window
HTTP 429 with retry-after seconds
Concurrency
Semaphore full
HTTP 503 "Prediction service is busy"
Body parse
Invalid JSON body
HTTP 400 "Invalid JSON body"
historicalData
Missing or empty array
HTTP 400 with descriptive message
Minimum history
historicalData.length < 504
HTTP 400 "Insufficient historical data: N days provided, minimum 504 required (~2 years)."
stockMetrics
Missing or not an object
HTTP 400 "stockMetrics is required"

5.3  What Does NOT Change
    • COOLDOWN_MS = 30,000 ms (30 seconds) — unchanged.
    • predictionSemaphore — unchanged, same import and usage.
    • Temp file pattern (randomUUID, tmpdir, writeFileSync, unlinkSync in finally) — unchanged.
    • Python spawn command: python3 predict_weighted_analysis.py <ticker> --input_file <path> — unchanged.
    • Logger usage — unchanged.


6. predict_weighted_analysis.py — Refactor Requirements
The existing script must be refactored. This section defines what changes and what stays the same. The goal is a clean separation: this script does ML only, no network calls.

CONSTRAINT: This script must not import yfinance or make any HTTP/network calls. All data arrives via the --input_file JSON. Any import of yfinance, requests, urllib, or similar must be removed.

6.1  New Input Fields to Consume
The input JSON now includes fields that did not exist in v1.0. The script must read and use all of the following:

Field Path in JSON
Type
How to Use
historicalData[].open/high/low
float
Include as model features (OHLCV). Previously only close was passed.
stockMetrics.trailingEps / forwardEps
float
Add as features with ~5% weight. Impute with sector median if null.
stockMetrics.revenueGrowth / earningsGrowth
float
Strong 6-12mo predictors. Weight ~8-12% combined.
stockMetrics.profitMargins
float
Add as feature.
stockMetrics.freeCashflow
float
Normalize by marketCap before using as feature.
stockMetrics.debtToEquity / returnOnEquity
float
Add as features.
stockMetrics.beta
float
Used in volatility classification logic.
stockMetrics.analystTargetMean
float
Compute analyst_target_premium = (targetMean - currentPrice) / currentPrice. Weight ~8-12%.
stockMetrics.analystOpinionCount
int
Use as reliability multiplier for analyst_target_premium feature.
stockMetrics.recommendationMean
float
1.0=Strong Buy, 5.0=Strong Sell. Add as direct feature.
macroData.vix[].close
float[]
Merge with OHLCV by date. Use most recent value and 20-day rolling avg.
macroData.treasury10y[].close
float[]
Merge with OHLCV by date. Use most recent value.
macroData.sectorEtf.data[].close
float[]
Compute 60-day rolling correlation with stock close. Add as feature.
dataQuality.historyYears
float
Factor into confidence_score calculation.
dataQuality.analystDataAvailable
bool
Factor into confidence_score calculation.
dataQuality.imputedFields
string[]
Factor into confidence_score calculation.

6.2  Model Architecture — TensorFlow LSTM
Replace the GradientBoostingRegressor with a stacked LSTM network using TensorFlow/Keras.

Framework
TensorFlow 2.x with Keras Sequential API
Input shape
(batch_size, 60, N_features) — sequences of 60 trading days
Layer 1
LSTM(128 units, return_sequences=True)
Layer 2
Dropout(0.2)
Layer 3
LSTM(64 units, return_sequences=False)
Layer 4
Dropout(0.2)
Output layer
Dense(2) — outputs [price_6m_scaled, price_1y_scaled] simultaneously
Loss function
Huber loss — robust to price outliers (tf.keras.losses.Huber())
Optimizer
Adam(learning_rate=0.001)
Callbacks
EarlyStopping(patience=15, restore_best_weights=True), ReduceLROnPlateau(patience=7, factor=0.5)
Max epochs
100
Batch size
32
Validation split
0.1 (10% of training data held as validation during training)
Random seed
Set numpy, tf, and python random seeds to 42 for reproducibility

DESIGN RATIONALE: The Dense(2) direct multi-output approach predicts both 6-month (t+126) and 1-year (t+252) prices in a single forward pass. This avoids compounding prediction error from iterative step-by-step forecasting. Training targets are the scaled close prices at t+126 and t+252 from each sequence.

6.3  Feature Engineering
Build the following feature set before fitting the scaler. Use an explicit, ordered FEATURE_COLUMNS constant — never rely on DataFrame column order.

Core OHLCV (unchanged from v1.0)
    • Open, High, Low, Close, Volume

Technical Indicators (add new long-horizon indicators)
    • Existing: MACD(12,26,9), Bollinger Bands(20), RSI(14), Stochastic(14), ATR(14), SMA(20), EMA(50)
    • New: SMA(200), EMA(200), 52-week high ratio (close / rolling_max(252)), 52-week low ratio (close / rolling_min(252)), 6-month ROC (Rate of Change), 12-month ROC, Golden Cross flag (SMA50 > SMA200 as binary int)

Fundamental Features (all from stockMetrics)
    • peRatio, pbRatio, trailingEps, forwardEps, revenueGrowth, earningsGrowth, profitMargins, debtToEquity, returnOnEquity, beta, dividendYield
    • analyst_target_premium = (analystTargetMean - currentPrice) / currentPrice — weight this by analystOpinionCount/40 (capped at 1.0) as a reliability scalar
    • recommendationMean (passed directly as a feature)

Macro Features (from macroData, merged by date)
    • vix_close (daily VIX), vix_20d_avg (20-day rolling mean of VIX)
    • treasury10y_close (daily 10Y yield)
    • sector_etf_60d_corr (60-day rolling Pearson correlation between stock close and sector ETF close)

Derived / Calendar Features
    • historical_volatility (30-day log return std * sqrt(252)) — already present in v1.0
    • month_sin = sin(2 * pi * month / 12), month_cos = cos(2 * pi * month / 12) — seasonal encoding
    • earnings_season_flag = 1 if month in [1, 4, 7, 10] else 0
    • EarningsBeatStreak — already present in v1.0
    • NewsSentiment — already present in v1.0 (update to use recency decay if publishedAt is provided)

6.4  Walk-Forward Cross-Validation
Method
sklearn.model_selection.TimeSeriesSplit(n_splits=3)
Test window
Minimum 126 trading days (6 months) per fold
Purpose
Compute mean validation MAE across folds for use in confidence_score calculation. Also used to detect overfitting before returning results.
Reporting
Log cross-validation MAE to stderr. Include cv_mae in accuracy_metrics.model output field.
Note
Given prediction latency targets (~10s), limit CV to 3 folds. Full 5-fold CV can be explored in a future optimization pass.

6.5  Confidence Score Calculation
Compute confidence_score_6m and confidence_score_1y (both integers 0-100). These are separate scores.

Factor
Max Points
Scoring Rule
Cross-validation MAPE
40 pts
MAPE < 5%: 40pts. MAPE 5-10%: 30pts. MAPE 10-20%: 15pts. MAPE > 20%: 0pts.
History depth
25 pts
historyYears >= 5: 25pts. 4-5yr: 20pts. 3-4yr: 12pts. 2-3yr: 5pts. < 2yr: 0pts.
Feature completeness
20 pts
Zero imputed fields: 20pts. 1-2 imputed: 14pts. 3-5 imputed: 8pts. >5 imputed: 0pts.
Analyst coverage
15 pts
analystOpinionCount >= 10: 15pts. 5-9: 10pts. 1-4: 5pts. 0: 0pts.

confidence_score_6m = sum of the four factor scores (max 100).
confidence_score_1y = max(0, confidence_score_6m - 15). The 1-year score is always at least 15 points lower than the 6-month score to reflect the wider uncertainty horizon.

6.6  Monthly Trajectory via Monte Carlo Dropout
Generate an 18-month price trajectory with uncertainty bounds using Monte Carlo Dropout inference.

Method
Run the trained LSTM in inference mode 100 times with dropout active (tf.keras.backend.set_learning_phase(1) or pass training=True). Collect 100 price predictions for each of the 18 monthly waypoints.
Mean
predicted_price for that month = mean of 100 runs
Lower bound
10th percentile of the 100 runs
Upper bound
90th percentile of the 100 runs
18 waypoints
Generate predictions at t+21, t+42, t+63, t+84, t+105, t+126 (6mo), t+147, t+168, t+189, t+210, t+231, t+252 (12mo), t+273, t+294, t+315, t+336, t+357, t+378 (18mo). Each is approximately 1 month (21 trading days).
Month labels
Compute the calendar month/year for each waypoint from the last date in historicalData. Format as "MMM YYYY" e.g. "Sep 2025".

6.7  Deviation Cap Removal
The existing hard-clip logic must be removed from the 1-year prediction path:

# REMOVE THIS from the prediction path:
# if abs(final_prediction - current_price) > current_price * max_deviation:
#     final_prediction = np.mean(stock_data["Close"].tail(20).values)

Replace with a soft flag only:
high_uncertainty = abs(predicted_price_1y - current_price) / current_price > 0.60

Return high_uncertainty as a boolean in the JSON response. Do not alter the predicted price.

6.8  Output JSON Schema
The script must return this JSON structure on stdout. All fields are required.

{
  "ticker": "AAPL",
  "regularMarketPrice": 182.50,
  "predicted_price_6m": 201.40,
  "predicted_price_1y": 218.70,
  "predicted_change_pct_6m": 10.4,
  "predicted_change_pct_1y": 19.8,
  "confidence_score_6m": 74,
  "confidence_score_1y": 59,
  "high_uncertainty": false,
  "predicted_change_range": [-8.20, 18.90],   // backward compat: 6m low/high change
  "monthly_trajectory": [
    { "month": "Mar 2025", "predicted_price": 186.10,
      "lower_bound": 179.40, "upper_bound": 192.80 },
    ...  // 18 total entries
  ],
  "accuracy_metrics": {
    "model": { "mae": 4.21, "rmse": 5.87, "cv_mae": 5.14 }
  },
  "stock_type": "growth_stock",
  "growth_rate_20d": 3.2,
  "is_uptrend": 1,
  "data_quality": {   // pass through from input dataQuality
    "historyDays": 1258, "historyYears": 4.99,
    "fundamentalsComplete": true, "analystDataAvailable": true,
    "imputedFields": []
  },
  "metric_analysis": { ... }   // existing structure, unchanged
}

IMPORTANT: predicted_change_range must remain in the response for backward compatibility during the transition. Set it to [predicted_price_6m_low - regularMarketPrice, predicted_price_6m_high - regularMarketPrice] using the 6-month trajectory bounds.


7. StockPrediction.tsx — Frontend Requirements
The StockPrediction component must be rewritten to implement the two-step data-fetch + predict flow and display the new dual-horizon prediction results.

7.1  Props Interface Changes
The historicalData prop is removed. All historical data now comes from the /data API route. All other existing props are retained for the sidebar metrics panel.

Prop
Change
Notes
historicalData
REMOVE
No longer passed — data fetched internally via /data route
ticker
KEEP
Used in both API calls
currentPrice
KEEP
Used for display before prediction runs
peRatio / pbRatio / marketCap / sma20 / sma50 / rsi / momentum
KEEP
Still displayed in the sidebar metrics panel
newsArticles
KEEP
Client-side sentiment. Merged into payload before predict call. Add optional publishedAt?: string and article_type?: string fields.
historicalEarnings
KEEP
Used as fallback if /data route earnings are empty. Superseded by yfinance earnings from /data route when available.

7.2  Two-Step Generate Flow
The generatePrediction function must implement two sequential API calls. Both must complete before results are shown.

Step 1
GET /api/stock/{ticker}/data. No request body. Returns the enriched data payload (Section 3.6 schema).
Step 2
POST /api/stock/{ticker}/predict/tensorflow. Body = Step 1 response merged with newsArticles from props and historicalEarnings fallback.
Loading indicators
Show two distinct loading states: "Fetching 5-year data..." during Step 1, "Running LSTM model..." during Step 2.
Error handling
Show errors from either step. If Step 1 fails, do not proceed to Step 2. Display the error message directly to the user.
Cooldown
429 responses from the predict route: parse the wait time from the message and show countdown in the button ("Retry in 28s").
Data quality
After Step 1 succeeds, check dataQuality fields. Surface non-blocking warnings above the button if historyYears < 5, fundamentalsComplete is false, or analystDataAvailable is false.

7.3  Results Display
7.3.1  Dual-Horizon Headline Cards
Display two side-by-side cards immediately below the button once results arrive.

Card
Label
Color Scheme
Contents
Left
6-Month Price Target
Blue border/background
Predicted price (large), % change from current, confidence badge, low-high range from trajectory month 6
Right
Long-Term Outlook (12 months)
Purple border/background
Predicted price (large), % change from current, confidence badge, low-high range from trajectory month 12, italic note: "Wider uncertainty — treat as directional guidance"

7.3.2  Confidence Badges
Each card has a confidence badge. The badge color and label are determined by the score:

Score Range
Label
Color
66 - 100
High Confidence
Green background, green text, green border
41 - 65
Medium Confidence
Amber background, amber text, amber border
0 - 40
Low Confidence
Red background, red text, red border

The badge must include a tooltip (title attribute) explaining the four factors that determine the score: data depth, cross-validation error, feature completeness, analyst coverage.

7.3.3  18-Month Trajectory Chart
Display an SVG line chart below the headline cards. Requirements:
    • X-axis: 18 monthly labels. Show every 3rd label to avoid crowding.
    • Y-axis: Price axis, 4 tick marks, formatted as currency.
    • Line: Predicted price trajectory in blue (hex #2563EB), 2px stroke.
    • Confidence band: Shaded area between lower_bound and upper_bound in semi-transparent blue (10-15% opacity).
    • Current price reference: Horizontal dashed gray line at regularMarketPrice, labeled "Current".
    • Month-6 boundary: Vertical dashed gray line between months 6 and 7. Label left side "Primary Forecast", right side "Extended Outlook".
    • Dots: Filled circle at month 6 waypoint (blue) and month 12 waypoint (purple).
    • No external charting library required. Implement as a plain SVG using viewBox and inline path/line/text elements.

7.3.4  High Uncertainty Banner
When high_uncertainty is true in the prediction response, display a dismissible yellow warning banner above the headline cards:

"This prediction carries high uncertainty. The predicted change exceeds
 ±60%. Treat this as a directional signal only, not a price target."

The banner must be dismissible via an X button. Once dismissed, it must not reappear unless a new prediction is generated.

7.3.5  Existing Panels (unchanged)
    • Sidebar metrics panel (RSI, Momentum, SMA Trend, P/E Ratio, Stock Type) — keep as-is.
    • Model performance panel (Accuracy %, MAE, RMSE) — keep. Add cv_mae display if present in response.
    • Detailed Metric Analysis accordion — keep. Add data_quality fields at the bottom.


8. Recommended Implementation Order
Complete phases sequentially. Each phase is independently testable before the next begins.

Phase
Work Item
Owner
Depends On
1
Create fetch_stock_data.py with all yfinance calls, imputation, and output schema
Backend
—
1
Validate fetch_stock_data.py output for 5+ tickers manually before wiring up the route
Backend
fetch_stock_data.py
1
Create GET /api/stock/[ticker]/data route with cache and process spawn
Backend
fetch_stock_data.py
1
Update POST /predict/tensorflow route: new body validation, remove old data expectations
Backend
—
2
Refactor predict_weighted_analysis.py: remove yfinance, add new input field consumption, add LSTM model
ML / Backend
Phase 1 complete
2
Implement walk-forward CV and confidence score calculation in predict script
ML / Backend
LSTM model working
2
Implement Monte Carlo Dropout trajectory generation
ML / Backend
LSTM model working
3
Update StockPrediction.tsx: two-step flow, remove historicalData prop, loading states
Frontend
Phase 1 routes done
3
Implement dual-horizon headline cards and confidence badges in StockPrediction.tsx
Frontend
Phase 2 output schema finalized
3
Implement SVG trajectory chart in StockPrediction.tsx
Frontend
monthly_trajectory in response
3
Implement high-uncertainty banner, data quality warnings
Frontend
Phase 2 output schema finalized
4
End-to-end integration test across 10+ tickers
All
All phases complete
4
Backtest validation: verify 6-month predictions on historical out-of-sample data
ML / Backend
All phases complete

9. Acceptance Criteria
All of the following must be true before this work is considered complete.

9.1  Architecture Constraint (Hard Requirement)
CONSTRAINT: predict_weighted_analysis.py must not import yfinance, requests, urllib, httpx, or any HTTP library. A code review check for these imports is required before merge.

9.2  Data Pipeline
    • fetch_stock_data.py returns valid JSON for any S&P 500 ticker with > 2 years of history.
    • Returned historicalData contains at least 504 rows for established tickers.
    • No fundamental field is returned as 0 when yfinance returns None — sector median imputation is applied.
    • analystTargetMean is populated for any ticker with analyst coverage on Yahoo Finance.
    • dataQuality.imputedFields correctly lists every field that was imputed.
    • GET /api/stock/[ticker]/data returns a cached response within 50ms on the second request within the TTL window.

9.3  Prediction Quality
    • Both predicted_price_6m and predicted_price_1y are present in every successful response.
    • confidence_score_1y is always <= confidence_score_6m.
    • monthly_trajectory contains exactly 18 objects with non-null predicted_price, lower_bound, and upper_bound.
    • high_uncertainty is true when either predicted change exceeds ±60% of current price.
    • predicted_change_range remains in the response for backward compatibility.
    • cv_mae is present in accuracy_metrics.model.

9.4  Performance
    • End-to-end prediction (button click to results displayed) completes within 15 seconds for 95th percentile requests on the production server.
    • Step 1 (data fetch) completes within 8 seconds on first fetch (cache miss).
    • Step 2 (LSTM prediction) completes within 10 seconds.

9.5  UI
    • Two distinct loading messages are shown during the two-step flow.
    • Both 6-month and 12-month prediction cards are visible without expanding any accordion.
    • Confidence badges render in the correct color for all three tiers.
    • The SVG trajectory chart renders on desktop and mobile viewports without horizontal overflow.
    • The high-uncertainty banner is dismissible and does not reappear after dismissal until a new prediction is generated.
    • Data quality warnings appear when historyYears < 5 or fundamentalsComplete is false.

10. Dependencies & Environment

10.1  New Python Dependencies
Package
Version (minimum)
Purpose
Install
tensorflow
2.12+
LSTM model training and inference
pip install tensorflow
yfinance
0.2.18+
Data fetching (fetch_stock_data.py only)
pip install yfinance
scikit-learn
1.2+
TimeSeriesSplit, MinMaxScaler
Already present
numpy
1.23+
Numerical operations
Already present
pandas
1.5+
DataFrame operations
Already present

IMPORTANT: TensorFlow must be installed in the same Python environment that is invoked by process.cwd() in the Next.js route. Confirm the correct python3 binary is used and that tensorflow is importable from it before beginning Phase 2.

10.2  No New Frontend Dependencies
The trajectory chart is implemented as a plain SVG — no new npm packages are required. All existing dependencies (React, Tailwind, formatters) are sufficient.

10.3  Environment Variables
No new environment variables are required. The data fetch route uses the same auth, origin check, and logger utilities already present in the codebase.

11. Out of Scope
The following are explicitly excluded from this work:

    • Next-day or intraday (minute/hour) predictions — short-term model is removed entirely.
    • Portfolio optimization or position sizing recommendations.
    • Real-time streaming model updates — batch prediction on demand only.
    • Historical analyst consensus data — current consensus via ticker.info only.
    • Alternative data sources beyond yfinance (Twitter/X sentiment, satellite data, earnings call transcripts).
    • Options pricing or derivatives forecasting.
    • Model explainability beyond the existing metric_analysis structure.


12. Appendix — Glossary

Term
Definition
LSTM
Long Short-Term Memory — a recurrent neural network architecture that retains state across long input sequences. Industry standard for financial time series forecasting.
GBR
Gradient Boosting Regressor — the scikit-learn model used in v1.0. Being replaced by LSTM.
Monte Carlo Dropout
A technique where dropout layers remain active during inference. Running the model 100 times produces a distribution of outputs; the mean is the prediction, the spread is the uncertainty.
Walk-forward validation
A time-series validation method that trains on historical data and tests on a subsequent window, then slides the window forward. Prevents data leakage.
MAPE
Mean Absolute Percentage Error — prediction error expressed as a percentage of the actual value. Used in confidence score calculation.
Huber loss
A loss function that behaves like MSE for small errors and MAE for large errors, making it robust to price outliers.
OHLCV
Open, High, Low, Close, Volume — the five standard fields in a daily price bar.
Dual-horizon
Producing both a 6-month and a 1-year price prediction from a single model run.
SMA / EMA
Simple / Exponential Moving Average.
ROC
Rate of Change — percentage price change over a lookback period (e.g., 6-month ROC = % change over last 126 trading days).
Golden Cross
When SMA(50) crosses above SMA(200) — a widely watched long-term bullish signal.
VIX
CBOE Volatility Index — measures expected 30-day market volatility. Fetched via yfinance ticker "^VIX".
TNX
Yahoo Finance ticker for the US 10-Year Treasury yield. Fetched via "^TNX".
Analyst target premium
(analystTargetMean - currentPrice) / currentPrice — how far above/below current price the analyst consensus sits.
Sector ETF
An exchange-traded fund tracking a market sector (e.g., XLK for Technology). Used as a relative-strength feature.
Sector median imputation
When a fundamental metric is null or 0, substitute the industry median for that sector rather than 0, which would produce a misleading feature value.
Confidence score
A 0-100 integer summarizing prediction reliability. Derived from CV error, data depth, feature completeness, and analyst coverage.
TTL
Time To Live — the duration for which a cached value is considered fresh (5 minutes for the data cache).
DXA
DocXA units used in Word documents. 1440 DXA = 1 inch.
