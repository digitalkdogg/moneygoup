---
purpose: Reference for all 39+ Next.js API routes — methods, auth requirements, request/response shapes, and key behavioural notes.
sources: src/app/api/*/route.ts
triggers: Called on user interactions, batch jobs, and internal server-to-server calls
related: [../system-flows/prediction-pipeline.md](../system-flows/prediction-pipeline.md), [../system-flows/auth-flow.md](../system-flows/auth-flow.md), [database-schema.md](database-schema.md)
last_updated: 2026-08-28
---

# API Routes Reference

GrowMyStocks exposes **39+ API routes** organised into 9 route groups. All routes are Next.js App Router Route Handlers (`route.ts` files). Every authenticated route validates the NextAuth JWT session and calls `checkApprovalGuard(userId)` to re-verify approval status against the database on each request.

!!! note "August 2026 changes"
    - `GET /api/dashboard/recommendations` now surfaces a fifth scope: `off_market_mover`. Pool algorithm redesigned as four independently-capped buckets merged in priority order, hard-capped at 20 total.
    - `GET /api/dashboard/deepmoney-picks` gains an `off_market_movers` array in its response.
    - `OFF_MARKET_MIN_CHANGE_PCT` threshold raised from 1% to 3%.

---

## Shared Utilities and Middleware

### src/proxy.ts — Route Guard

NextAuth `withAuth` middleware. Protects all routes by default. The matcher excludes `/api/auth/*`, static assets, and public paths. Internal server-to-server requests bypass auth via an `x-api-key` header check.

Per-request CSP: a unique cryptographic nonce is generated via `crypto.getRandomValues()` for every request, injected into the `Content-Security-Policy` response header, and passed to page components via the `x-nonce` request header.

### checkOrigin() — src/utils/originCheck.ts

Validates the `Origin` header against `NEXT_PUBLIC_NEXTAUTH_URL`. Returns 403 if the origin does not match. Applied to nearly all POST/PATCH/PUT/DELETE endpoints.

### Rate Limiters — src/utils/rateLimiter.ts

| Limiter | Applied to | Limit |
|---|---|---|
| `loginLimiter` | Auth credentials check | 10 / 15 min per IP |
| `registerLimiter` | POST /api/auth/register | 5 / 15 min per IP |
| `forgotPasswordLimiter` | POST /api/auth/forgot-password | 3 / 15 min per IP |
| `resetPasswordLimiter` | POST /api/auth/reset-password | 5 / 15 min per IP |
| `stockDataLimiter` | GET /api/stock_data/[ticker] | Configurable |
| `unsubscribeLimiter` | POST /api/unsubscribe | Configurable |

!!! warning "TRUSTED_PROXIES"
    `getClientIP()` only trusts forwarded headers when `TRUSTED_PROXIES` is configured and the direct request IP is in that list. Set `TRUSTED_PROXIES` to your nginx/load-balancer IP in production.

### LimitService — src/utils/limitService.ts

Role-based limits: watchlist item count, portfolio position count, and daily stock lookup count. Roles: `user`, `superuser`, `admin`. Admin has no cap on lookups.

---

## Auth Routes

### `POST /api/auth/register`

No auth required. Rate limited. Origin check.

Creates a new user account with `approval_status: 'pending'`.

**Request body (Zod validated):**

```json
{
  "username": "string (3–50 chars, alphanumeric + underscore)",
  "email":    "string (valid email format)",
  "password": "string (8–100 chars, must contain a number)"
}
```

**Response:**

```
201 { "message": "...", "userId": number, "approvalStatus": "pending" }
400 { "error": "Email already registered" | "Username taken" | validation errors }
409 { "error": "conflict message" }
429 { "error": "Too many requests" }
```

### `POST /api/auth/forgot-password`

No auth required. Rate limited. Always returns a generic success message regardless of whether the email exists (prevents email enumeration).

**Request body:** `{ "email": "string" }`

### `GET /api/auth/reset-password`

No auth required. Validates the reset token without consuming it.

**Query params:** `token=<64-char hex>`

### `POST /api/auth/reset-password`

No auth required. Rate limited. Validates and consumes the token, hashes the new password, updates the `users` table, marks the token as used.

**Request body:** `{ "token": "string", "password": "string (8–100 chars, must contain a number)" }`

### `GET, POST /api/auth/[...nextauth]`

No auth required. NextAuth.js public handler. Delegates all NextAuth routes to `NextAuth(authOptions)` defined in `src/lib/auth.ts`.

---

## User Routes

### `GET /api/user/portfolio`

Auth required. Returns the authenticated user's full portfolio enriched with live market data. Queries `user_stocks` joined with `stocks`, `user_stock_predictions`, `stock_gps_scores`, and `stock_brand`. Horizon-aware — reads the user's `investment_timeframe` via `getUserStrategy()` and exposes horizon-keyed columns.

**Response shape:**

```json
{
  "portfolio": [
    {
      "stock_id": "number",
      "symbol": "string",
      "company_name": "string",
      "shares": "number",
      "purchase_price": "number",
      "regularMarketPrice": "number",
      "predicted_price_1m": "number | null",
      "predicted_price_horizon": "number | null",
      "predicted_change_pct_horizon": "number | null",
      "confidence_score_horizon": "number | null",
      "gpsScore": "number | null",
      "gpsBreakdown": "object | null",
      "gpsHorizon": "string",
      "is_etf": "boolean"
    }
  ],
  "horizonLabel": "string",
  "totals": { "...": "..." },
  "ratings": [{ "...": "..." }],
  "asOf": "string"
}
```

### `GET /api/user/portfolio/historical-value`

Auth required. Reconstructs the portfolio's total value for each trading day over the requested period using `yahooFinance.chart()`.

**Query params:** `period` — `'1w' | '1m' | '6m' | '1y' | 'all'`

**Response:** `{ "data": [ { "date": "YYYY-MM-DD", "value": number }, ... ] }`

### `GET, POST, DELETE /api/user/watchlist`

Auth required. Horizon-aware GPS (same `adjustGpsForHorizon()` logic as portfolio). GET returns watchlist items with live prices and a 6-month moving average from `stocksdailyprice`. POST adds a stock to the watchlist (checks `LimitService`). DELETE removes a stock by symbol.

**POST body:** `{ "ticker": "string", "name": "string" }`

**DELETE query:** `?stockId=<ticker>`

### `POST /api/user/stocks`

Auth required. Origin check. Adds a new stock to the portfolio or increases an existing position using weighted average price.

**Request body:** `{ "ticker": "string", "company_name": "string", "shares": number, "purchase_price": number }`

### `PATCH, PUT /api/user/stocks/[stock_id]`

Auth required. Origin check. Manages position changes.

| `action` value | Body fields | Behaviour |
|---|---|---|
| `buy` | `shares`, `price` | Increases position, recalculates weighted average |
| `sell_partial` | `shares` | Decreases shares; errors if shares would go below zero |
| `sell_all` | — | Removes position entirely from `user_stocks` |

### `GET, PATCH /api/user/profile`

Auth required. GET returns the user's profile, stats, and investment strategy. PATCH updates the investment strategy (`aggressiveness` and/or `investment_timeframe`). Changes take effect immediately for portfolio/watchlist/recommendations reads.

**PATCH request body (two accepted shapes):**

```json
// Nested (preferred):
{ "strategy": { "aggressiveness": "safe|neutral|aggressive", "investment_timeframe": "1_week|1_month|3_month|6_month" } }

// Flat (legacy):
{ "aggressiveness": "safe|neutral|aggressive", "investment_timeframe": "1_week|1_month|3_month|6_month" }
```

---

## Dashboard Routes

### `GET /api/dashboard`

Auth required. Returns the user's stock holdings merged with Yahoo Finance live quotes and computed technical indicator signals.

### `GET /api/dashboard/recommendations`

Auth required. Aggregates GPS-scored predictions across five scopes and returns BUY/SELL recommendations via a unified pool algorithm. Hard cap of 20 cards total.

**Five scopes:**

| Scope | Source | Action |
|---|---|---|
| `portfolio` | User confirmed, purchased, active stocks | BUY or SELL |
| `watchlist` | User confirmed, not purchased | BUY only |
| `discovery` | AI-discovered, not user-confirmed | BUY only |
| `etf_holding` | From `etf_stock_recommendations`, latest snapshot | BUY only |
| `off_market_mover` | `recommended_stocks` WHERE `type='off_market_mover'`, 2-day rolling window | PRE-MKT or AFTER-HRS |

**Pool assembly (August 2026 — four independently-capped buckets in priority order):**
1. Pinned — all portfolio/watchlist/SELL recs, always shown, no cap
2. Movers — up to `DASHBOARD_MOVER_CAP` (default 4) positive off-market movers
3. ETF — up to `DASHBOARD_ETF_CAP` (default 4) ETF holding recs
4. Discovery — fills remaining budget up to `DASHBOARD_DISCOVERY_CAP` (default 8)

Results are deduplicated by symbol, then hard-capped at 20 total.

**Strategy-aware GPS thresholds (examples at env defaults):**

| Strategy | BUY gate | SELL gate | Discovery BUY gate |
|---|---|---|---|
| safe / 1_month | 65 × 1.05 = 68.3 | 45 | 70 × 1.05 = 73.5 |
| neutral / 1_month | 65 | 45 | 70 |
| aggressive / 1_month | 65 × 0.95 = 61.8 | 45 | 70 × 0.95 = 66.5 |

**Macro GPS adjustment:** fetches World Bank data (6-hour cached) and applies ±3 pt macro adjustment to each GPS score before threshold comparison.

**Key response fields:**

```json
{
  "recommendations": [
    {
      "stockId": "number",
      "symbol": "string",
      "action": "BUY | SELL",
      "gpsScore": "number | null",
      "gpsBreakdown": "object | null",
      "scope": "portfolio | watchlist | discovery | etf_holding | off_market_mover",
      "etfTicker": "string | undefined",
      "offMarketChangePct": "number | undefined",
      "offMarketLabel": "Pre-Market | After-Hours | undefined",
      "consecutiveDays": "number | null"
    }
  ],
  "horizonLabel": "string",
  "asOf": "string"
}
```

### `GET /api/dashboard/deepmoney-picks`

Auth required. Returns the latest AI-curated snapshot from `recommended_stocks` and `hot_etfs`. Response includes four arrays: `hot_stocks`, `hot_etfs`, `etf_holdings`, `off_market_movers`. Also returns `timeframe` and `timeframe_label` from the user's strategy.

### `GET /api/dashboard/analyst-ratings`

Auth required. Cached. Fetches analyst consensus data from Yahoo Finance for all of the authenticated user's holdings.

### `GET /api/dashboard/on`

Auth required. Checks whether a given ticker is on the authenticated user's watchlist or portfolio.

**Query params:** `?ticker=<symbol>`

**Response:** `{ "onWatchlist": boolean, "onPortfolio": boolean, "shares": number | null, "purchaseDate": string | null, "purchasePrice": number | null }`

---

## Prediction Routes

### `POST /api/prediction/[ticker]`

Auth or internal API key. Rate limited (LimitService). Runs the ML prediction pipeline for a single ticker. Spawns `scripts/predict_weighted_analysis.py` via Node `child_process.spawn` inside a semaphore. Results are cached in `predictionCache` and persisted asynchronously.

**Guards applied in order:**

| Guard | Behaviour |
|---|---|
| Origin check / session auth | Internal `x-api-key` bypasses session requirement |
| Approval guard | Rejects suspended accounts even with valid session |
| LimitService lookup quota | 403 LIMIT_EXCEEDED if daily lookup count exceeded |
| `predictionCache` check | Returns cached prediction if `?refresh=true` not set |
| Historical data validation | 422 if fewer than 200 days of `historicalData` |
| `predictionSemaphore` | Caps concurrent Python subprocesses; 503 Busy if full |

**Query params:** `outlook` (1_week | 1_month | 3_month | 6_month | all), `refresh=true`

**Key response fields:**

```json
{
  "ticker": "string",
  "regularMarketPrice": "number",
  "predicted_price_1w": "number",
  "predicted_price_1m": "number",
  "predicted_price_3m": "number",
  "predicted_price_6m": "number",
  "confidence_score": "number",
  "gps_score": "number",
  "gps_breakdown": "object",
  "gps_horizon": "string",
  "source": "livedata | cache"
}
```

### `GET /api/prediction/[ticker]/ai-take`

Auth required. Cache-first (12h TTL). Rate limited (1 fresh gen / user / ticker / hour, default). Returns a Gemma-generated ~60-80 word paragraph analysis streamed as `text/plain`. Backs the "Ask AI" panel on `/search/[ticker]`.

**Cache key:** SHA-256 of `(OLLAMA_MODEL_AI_TAKE + gps_score + gps_breakdown + predicted_change_pct + analyst_upside + trading_signal)`. Headlines intentionally excluded to preserve the 12h cache.

**Query params:** `fresh=0|1` (bypasses cache when 1; used by the Regenerate button), `cache_only=1` (fast auto-load path — runs DB context and cache lookup in parallel)

**Response:** Streaming `text/plain` body (~60-80 words). Metadata in response headers:

| Header | Value |
|---|---|
| `X-AiTake-Cached` | `"true"` / `"false"` |
| `X-AiTake-Growth-Label` | `"Low Growth" | "Moderate" | "Growth" | "High Growth"` |
| `X-AiTake-Risk-Label` | `"Low Risk" | "Moderate Risk" | "High Risk" | "Speculative"` |
| `X-AiTake-Quadrant` | `"Quality Growth" | "Speculative" | "Defensive" | "Caution"` |

**Status codes:** 200 (cached or fresh), 404 (no GPS data yet), 429 (rate limited without cache), 503 (`AI_TAKE_ENABLED=off` or Ollama unreachable)

### `POST /api/prediction/save`

Auth or internal API key. Origin check. Persists a prediction result to `user_stock_predictions`. Upserts on `(user_id, stock_id)`. GPS score is mirrored to `stock_gps_scores` and `stock_gps_score_history` only when the score has actually changed at 1-decimal precision.

**Key request body fields:**

```json
{
  "ticker": "string",
  "predicted_price_1m": "number (positive, required)",
  "predicted_price_1w": "number | optional",
  "predicted_price_3m": "number | optional",
  "predicted_price_6m": "number | optional",
  "predicted_change_pct_1w|1m|3m|6m": "number | optional",
  "confidence_score_1w|1m|3m|6m": "number 0-100 | optional",
  "gps_score": "number 0-100 | null | optional",
  "gps_breakdown": "object | optional",
  "user_id": "string (required for internal x-api-key calls only)"
}
```

### `GET /api/prediction/deepmoney`

Auth or internal API key. Rate limited. 5-min cache per outlook. Real-time AI discovery engine. Harvests tickers from ~28 RSS/JSON/SEC feeds plus three non-feed sources, enriches with Yahoo Finance fundamentals, filters through signal scoring and the LightGBM ranker, runs ML prediction.

**Strategy-driven ML gates (minimum positive predicted change):**

| Timeframe | ML Gate |
|---|---|
| 1_week | 0.5% |
| 1_month | 1.5% |
| 3_month | 3.0% |
| 6_month | 5.0% |

---

## Analytics Routes

### `GET /api/analytics/model-accuracy`

No auth required (in `PUBLIC_PATHS`). 1-hour in-memory cache. Powers the dashboard's `ModelAccuracyWidget` and the public landing page's "Proven Track Record" section.

**Modes:** global (no `symbol` param — aggregates all resolved rows) and per-symbol (filtered to a single ticker).

**Proximity formula:**

```
accuracy_score = MAX(0, 1 - ABS(predicted - actual) / actual)
proximity_accuracy_pct = ROUND(100 × AVG(accuracy_score), 2)
```

A prediction is "high accuracy" when `accuracy_score >= 0.95`.

**Requires a minimum of 30 resolved prediction rows to return `status: 'ready'`.**

**Query params:** `symbol` (optional), `skip_cache=true` (bypasses and clears the entire cache map)

**Response statuses:** `ready`, `insufficient_data`, `no_data`

---

## Stock Data Routes

### `GET /api/search`

Auth required. Semantic ticker/company/category search. Three passes in order:

1. **Exact ticker** — `WHERE symbol = ?` (score: 1,000,000)
2. **Symbol/name prefix** — `symbol LIKE 'q%' OR company_name LIKE 'q%'`
3. **FULLTEXT boolean-mode** — `MATCH(symbol, company_name, sector, industry, search_tsv) AGAINST(? IN BOOLEAN MODE)`

The `search_tsv` synonym blob (populated by `scripts/backfill_stock_search.py`) is what makes "Large Retail" hit WMT.

**Query params:** `q` (required, max 64 chars), `limit` (optional, default 20, max 50)

**Response:**

```json
{
  "query": "string",
  "results": [{ "symbol": "string", "name": "string", "sector": "string | null", "industry": "string | null", "size": "mega|large|mid|small|micro|nano|null", "matchType": "exact|prefix|fulltext" }]
}
```

### `GET /api/stock_data/[ticker]`

Auth required. Rate limited. Main stock data aggregation endpoint. Fetches from Yahoo Finance, records a lookup event, computes technical indicators (SMA20/50, RSI14, Momentum, signal score). Uses in-flight deduplication for concurrent requests.

### `GET /api/stock_data/[ticker]/gps`

Auth required. Returns the GPS v3.0 score for a ticker. Checks `stock_gps_scores` first, then falls back to `recommended_stocks`. Concurrently fetches Yahoo Finance `recommendationKey` to enrich pre-v3.0 breakdowns.

**Response:**

```json
{
  "gpsScore": "number | null",
  "gpsBreakdown": "object | null",
  "source": "stock_gps_scores | recommended_stocks | none",
  "asOf": "string | null"
}
```

### `GET /api/stock_data/[ticker]/latest-prediction`

12-hour window. Returns the freshest `prediction_records` row for this ticker if `created_at >= NOW() - INTERVAL 12 HOUR`, filtered by the current model version. Consumed by `Stock.tsx` so prediction cards render immediately on page load without requiring a "Generate Prediction" click. Falls through to `null` when stale, missing, or from a different model version.

Public read (`checkOrigin` only, no session required) so a logged-out visitor to `/search/[ticker]` can still see the prediction.

### `GET /api/stock_data/[ticker]/data`

Auth required. Enriched stock data endpoint consumed by the prediction pipeline. Computes `calculateTechnicalIndicators(historicalData, news, peRatio, pbRatio, marketCap)` and returns `technicalScore` at the top level.

### `GET /api/earnings-calendar`

Auth required. 6-hour cache. Fetches next 5 business days from the NASDAQ earnings API, groups by date, attaches GPS scores from `stock_gps_scores`. A stop-list of common non-ticker tokens is applied to filter noise.

---

## Market Routes

### `GET /api/market/indices`

Auth required. Returns live prices and daily change for DJI, S&P 500, NASDAQ, and VIX from Yahoo Finance.

### `GET /api/market/trending`

Auth required. Returns trending stocks over a configurable time window. Used internally by the DeepMoney discovery engine (`?window=48h&limit=50`).

### `GET /api/stock_data/[sector]/industry`

Auth required. Returns sector leader stocks sorted by GPS score (joined against `stock_gps_scores`).

---

## Admin Routes

### `GET, PATCH /api/admin/users`

Admin session required. GET returns a list of users (filterable by `status`, `role`, `search`). PATCH updates a user's `approval_status` or `role`. PATCH triggers `sendApprovalEmail()` automatically when `approval_status` is set to `"approved"`. Prevents demoting the last admin. See [admin-user-mgmt.md](../system-flows/admin-user-mgmt.md) for full detail.

---

## World Bank and Macro Routes

### `GET /api/worldbank`

Auth required. 6-hour cache. Returns consolidated World Bank macroeconomic indicators (GDP Growth, Inflation, FDI, Trade Volume, Unemployment) for USA, GBR, CHN, IND, DEU. Used by the recommendations route for macro GPS adjustments.

---

## Misc Routes

### `POST /api/unsubscribe`

No auth required (public by design, RFC 8058). Secured via HMAC-signed token in the URL. Sets `approval_status = 'unsubscribed'` for the matched account.

### `GET /api/stock_data/[ticker]/ai-take` → see Prediction Routes above

### `POST /api/contact`

No auth required. Accepts contact form submissions. Sends an internal notification email via Resend.
