---
purpose: What technologies the app uses and how they are wired together, for engineers and technical PMs.
sources: architecture_documentation.html, src/utils/databaseHelper.ts, src/proxy.ts, src/utils/cache.ts
triggers: N/A — static reference
related: [index.md](index.md), [reference/api-routes.md](reference/api-routes.md), [reference/database-schema.md](reference/database-schema.md)
last_updated: 2026-08-28
---

# Architecture

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | Server Components + Client Components; RSC streaming supported |
| Language | TypeScript | Strict mode; Zod for runtime validation |
| Styling | Tailwind CSS | Brand color via CSS custom properties (`--brand-green-700`) |
| Font | Rubik (Google Fonts) | Weights 400/500/600/700, latin subset |
| Authentication | NextAuth.js v4 | CredentialsProvider, JWT session strategy, bcryptjs password hashing |
| Database | MySQL | Custom helper wrappers in `src/utils/databaseHelper` |
| Market Data | yahoo-finance2 | Primary source for quotes, historical prices, analyst summaries, earnings. ETF detection uses `quoteResult.quoteType === 'ETF'` (dynamic). Historical data uses `yahooFinance.chart()`. |
| ML Prediction | Python subprocess | `scripts/predict_weighted_analysis.py` spawned via Node `child_process`. Model variant selected by `MODEL_VARIANT` env var (`v3`/`v4`/`v5`, default `v5`). CS model version selected by `CS_MODEL_VERSION`. |
| Charts | Recharts | Stock price history and portfolio value charts |
| Email | Resend | Registration, approval, password reset, contact form |
| Macro Data (World Bank) | World Bank API | GDP, inflation, unemployment, globalHealthScore; 6-hour cache |
| Macro Data (FRED) | FRED API | 9 series synced nightly via `scripts/fred_macro_sync.py`; stored in `fred_macro_indicators` table |
| Validation | Zod | All API route inputs validated with Zod schemas |
| Rate Limiting | Custom (`src/utils/rateLimiter.ts`) | Redis-backed; 6 distinct limiters; IP extraction respects `TRUSTED_PROXIES` |
| Local LLM | Ollama | NER extraction in DeepMoney sync; AI Take paragraph on stock detail page |

---

## Directory Structure

```
src/
├── app/
│   ├── layout.tsx                  Root layout (font, Navigation, Footer, Providers)
│   ├── page.tsx                    Home / landing page — renders LandingPage
│   ├── providers.tsx               SessionProvider wrapper
│   │
│   ├── components/                 All React components
│   │   ├── Navigation.tsx
│   │   ├── Footer.tsx
│   │   ├── Dashboard.tsx
│   │   ├── RecommendationsSection.tsx
│   │   ├── cards/                  Card system (types, StockCard, BaseCardShell, …)
│   │   │   └── variants/           PortfolioCardView, WatchlistCardView, …
│   │   └── modals/                 GpsBreakdownModal, BuyMoreModal, SellModal, …
│   │
│   └── api/                        Next.js API Route Handlers
│       ├── auth/                   [...nextauth], register, forgot-password, reset-password
│       ├── user/                   portfolio, watchlist, stocks, profile
│       ├── dashboard/              route.ts, recommendations, deepmoney-picks, analyst-ratings
│       ├── prediction/             [ticker], bellwether, deepmoney, save
│       ├── stock_data/[ticker]/    route.ts, gps, data, holdings, industry
│       ├── earnings-calendar/
│       ├── market/                 indices, trending
│       ├── admin/users/
│       ├── etf/holdings-recommendation/
│       └── worldbank/
│
├── lib/
│   └── auth.ts                     NextAuth authOptions
│
├── proxy.ts                        Route protection (withAuth middleware + CSP nonce)
│
└── utils/
    ├── databaseHelper.ts           executeRawQuery, insert, upsert, update, remove
    ├── etfDiscovery.ts             ETF scoring + holdings phase
    ├── etfHoldings.ts              fetchETFHoldings, scoreETFHoldings
    ├── rateLimiter.ts              loginLimiter, registerLimiter, etc.
    ├── limitService.ts             Role-based resource quotas
    ├── originCheck.ts              checkOrigin() middleware
    ├── cache.ts                    predictionCache, stockDataCache
    ├── gps.ts                      calculateGpsScore, adjustGpsForHorizon
    ├── strategy.ts                 getUserStrategy, resolveStrategy, AGGRESSIVENESS_GATES
    ├── logger.ts                   createLogger(namespace)
    └── formatters.ts               Global number/date formatters

scripts/
├── deepmoney_sync.py              Full discovery + ETF sync orchestrator
├── update_predictions.py          Portfolio prediction sync + ETF holdings scan
├── predict_weighted_analysis.py   Python ML prediction orchestrator
├── predict_short_term.py          1w + 1m MLP heads
├── predict_long_term.py           3m + 6m CS model heads
├── predict_core.py                Shared features, caching, sanitize
├── fred_macro_sync.py             Fetches 9 FRED series → fred_macro_indicators
├── score_ranker.py                LightGBM ranker inference
└── ranker_features.py             Feature extraction for ranker

public/
├── growmystock_logo.svg
└── company_tickers.json           SEC full ticker list (search fallback name lookup)
```

---

## Auth and Approval Flow

### Registration

1. User submits registration form (username, email, password).
2. `POST /api/auth/register` validates input via Zod. Checks email + username uniqueness.
3. Password hashed with bcryptjs (10 rounds). User inserted with `approval_status: 'pending'`.
4. Resend sends confirmation email to user and notification to admin.
5. User cannot log in until an admin approves the account.

### Login

1. User submits credentials (email + password).
2. NextAuth CredentialsProvider calls `loginLimiter` rate check.
3. Looks up user by email. Runs `bcryptjs.compare(password, hash)`.
4. Calls `evaluateApprovalStatus()` — throws a descriptive error if pending or rejected.
5. JWT created with `id`, `role`, `approvalStatus`. Redirects to dashboard.

### Session and Middleware

All routes except public ones are protected by NextAuth `withAuth` middleware in `src/proxy.ts`. The middleware reads the JWT session token from the cookie and redirects unauthenticated requests to `/login`.

!!! warning "Two-layer session verification"
    The JWT session token carries `id`, `role`, and `approvalStatus` (set at login time). For every authenticated API request, all protected endpoints additionally call `checkApprovalGuard(userId)` which re-queries the database to verify the account is still approved. This prevents stale sessions from accessing data after an account is suspended. The guard fails closed: on DB error, access is denied.

Server-to-server internal calls bypass authentication using an `x-api-key` header matching `DEEPMONEY_INTERNAL_SECRET` (minimum 32 bytes; shorter values silently disable the bypass).

---

## AI Prediction Pipeline

### Two-Step Architecture

1. **Step 1 — Data fetch:** `StockPrediction` component calls `GET /api/stock_data/{ticker}/data`, which assembles an enriched payload (historical prices, fundamentals, technicals, analyst data, macro context) formatted for the Python model. Result cached in `stockDataCache`.
2. **Step 2 — Model run:** Component POSTs the payload to `POST /api/prediction/{ticker}`. Route checks `predictionCache` first. If no cache hit, validates ≥200 days history, then acquires a semaphore slot.
3. **Python execution:** `child_process.spawn` runs `scripts/predict_weighted_analysis.py`, passing JSON payload. Script returns all four horizons in one call.
4. **Result handling:** Route caches the result in `predictionCache` and fires async POST to `/api/prediction/save` to persist in `user_stock_predictions`.

### Post-Hoc Adjustment Stack (MODEL_VARIANT)

| Value | Behavior |
|---|---|
| `v3` | Legacy adjustments only (pre-June 2026). |
| `v4` | Adds inline telemetry + expanded bearish-regime handling. |
| `v5` | **Default.** Adds beta-scaled deadband, momentum-overreach ceiling (30-day return >30% caps upside), and bearish-cascade damping when beta > 0.8 and 30d/90d returns are both negative. |

!!! note "Two separate env vars"
    `MODEL_VARIANT` selects the post-hoc adjustment code path in `predict_weighted_analysis.py`. `CS_MODEL_VERSION` selects which cross-sectional model pickle is loaded (e.g., `long_term_cs_v5.pkl`). They are independent.

### Prediction Guards

| Guard | Behavior |
|---|---|
| LimitService lookup quota | 429 if user's daily lookups exhausted |
| 30-second per-user-per-ticker cooldown | Returns cached result immediately within window |
| predictionCache | In-memory cache; returns stale prediction if fresh enough |
| Minimum history validation | 422 if fewer than 200 days of historical prices |
| predictionSemaphore | Caps concurrent Python subprocesses |

---

## Card System Architecture

All stock display cards use a single discriminated union type `StockCardModel` with four variants, routing to the correct view without prop drilling:

```typescript
type StockCardModel =
  | SearchTrendingCard  // variant: 'search-trending'
  | DeepmoneyCard       // variant: 'deepmoney'
  | PortfolioCard       // variant: 'portfolio'
  | WatchlistCard       // variant: 'watchlist'
```

**Rendering chain:**

```
StockCard (React.memo)
  └─ BaseCardShell (hover, keyboard a11y)
       ├─ PortfolioCardView
       ├─ WatchlistCardView — includes GpsTooltip "View score" button
       ├─ DeepmoneyCardView
       └─ SearchTrendingCardView
```

---

## Database Patterns

### Query Helper Wrappers (`src/utils/databaseHelper.ts`)

| Helper | Usage |
|---|---|
| `executeRawQuery(sql, params)` | Arbitrary SELECT queries with parameterized inputs |
| `insert(table, data)` | INSERT a single row; returns insertId |
| `upsert(table, data, conflictKey)` | INSERT … ON DUPLICATE KEY UPDATE |
| `update(table, data, where)` | UPDATE with WHERE clause |
| `remove(table, where)` | DELETE with WHERE clause |

### Weighted Average Price Calculation

When a user buys additional shares, purchase price recalculates as:

```
newAvgPrice = (existingShares × existingAvgPrice + newShares × newPrice)
              / (existingShares + newShares)
```

---

## External Services

### Yahoo Finance (`yahoo-finance2`)
- Real-time quotes and daily change
- Historical OHLCV price data
- Analyst consensus + price targets
- Earnings data (EPS actual vs. estimate)
- ETF detection: `quoteType === 'ETF'` (dynamic; replaced static SEC list in June 2026)

### Resend (Email)
Three API keys via environment variables:
- `RESEND_API_KEY` — auth emails (registration, approval, password reset)
- `RESEND_CONTACT_API_KEY` — contact form emails
- `RESEND_FROM_EMAIL` — sender address

### FRED API (Federal Reserve Economic Data)
- 9 series: PAYEMS, UNRATE, CIVPART, CPIAUCSL, CPILFESL, FEDFUNDS, GDP, T10Y2Y, UMCSENT
- Synced nightly via `scripts/fred_macro_sync.py`
- Stored in `fred_macro_indicators` table
- Requires `FRED_API_KEY` environment variable

### Ollama (Local LLM)
Runs on same host at `OLLAMA_BASE_URL` (default `http://localhost:11434`):
- **DeepMoney NER pass** — extracts tickers from news article text; uses `OLLAMA_MODEL` (default `llama3.2`)
- **AI Take** — generates ~60-80 word paragraph on `/search/[ticker]` via `OLLAMA_MODEL_AI_TAKE` (default `gemma3:1b`, ~1 GB RAM)

---

## Caching Strategy

| Cache | Module | TTL / Invalidation |
|---|---|---|
| `predictionCache` | `@/utils/cache` | Time-based; checked before spawning Python |
| `stockDataCache` | `@/utils/cache` | Time-based; caches enriched data payload for Python input |
| Indices cache | `/api/market/indices` | In-memory; refreshed every 2 minutes |
| Trending cache | `/api/market/trending` | 15-minute in-memory cache |
| World Bank cache | `/api/worldbank` | 6-hour in-memory cache |
| Earnings calendar cache | `/api/earnings-calendar` | 6-hour module-level in-memory cache |

### In-Flight Request Deduplication

The stock data route (`GET /api/stock_data/[ticker]`) maintains a module-level `inflightRequests` Map. If a second request for the same ticker arrives while the first is still awaiting Yahoo Finance, the second request attaches to the existing Promise instead of spawning a duplicate fetch.

The AI Take route uses the same pattern keyed on `(ticker, data_hash)` — only one Gemma inference runs for concurrent requests on the same ticker.

---

## LimitService — Role-Based Quotas

| Limit type | user | superuser | admin |
|---|---|---|---|
| Daily stock lookups | Limited | Higher limit | Unlimited |
| Portfolio positions | Limited | Higher limit | Higher limit |
| Watchlist items | Limited | Higher limit | Higher limit |

Source: `src/utils/limitService.ts`
