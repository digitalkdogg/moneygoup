---
purpose: Complete reference for every environment variable the application reads — what each knob does, its default, where it is consumed, what the user sees when it is misconfigured, and concrete tuning examples.
sources: src/lib/auth.ts, src/utils/originCheck.ts, src/utils/rateLimitMiddleware.ts, src/utils/redisRateLimiter.ts, src/utils/databaseHelper.ts, src/lib/email.ts, src/app/api/contact/route.ts, src/utils/algorithmPreset.ts, src/utils/etfHoldingPreset.ts, src/utils/gps.ts, src/utils/ollamaClient.ts, src/app/api/prediction/[ticker]/ai-take/route.ts, src/app/api/dashboard/recommendations/route.ts, src/instrumentation.ts, scripts/deepmoney_sync.py, scripts/update_predictions.py
triggers: Read at server startup and on each request where the consuming module is loaded; no hot-reload — changes require a server restart
related: [architecture.md](../architecture.md), [system-flows/auth-flow.md](../system-flows/auth-flow.md), [data-integrations/deepmoney-sync.md](../data-integrations/deepmoney-sync.md), [business-rules/gps-score.md](../business-rules/gps-score.md)
last_updated: 2026-08-28
---

# Environment Variables

Every runtime knob the application reads, grouped by concern. Variables marked **required** will cause the app to fail to start or silently break a critical feature if absent. Variables marked **optional** have a code-level default and only need to be set when you want to override the default.

!!! warning "Restart required"
    Environment variable changes are not hot-reloaded. After editing `.env`, restart the Next.js server and any Python sync scripts that read the same variables.

---

## System — Auth, Security, Session, Infrastructure

| Variable | Required? | Default |
|---|---|---|
| `NEXTAUTH_SECRET` | Required | — |
| `NEXTAUTH_URL` | Required | — |
| `NEXT_PUBLIC_SITE_URL` | Optional | Falls back to `NEXTAUTH_URL` |
| `ALLOWED_ORIGINS` | Optional | Falls back to `NEXTAUTH_URL` |
| `TRUSTED_PROXIES` | Optional | Empty — only the direct peer is trusted |
| `DEEPMONEY_INTERNAL_SECRET` | Required | — |
| `SESSION_MAX_AGE` | Optional | `86400` (24 h) |
| `REDIS_URL` | Required for prod | In-memory fallback (unsafe across instances) |

### NEXTAUTH_SECRET

Cryptographic key NextAuth uses to sign JWT session tokens. Rotating it invalidates every live session immediately.

- **Where used:** `src/lib/auth.ts`, every `getServerSession()` call
- **User impact:** Every authenticated page (`/`, `/portfolio`, `/search`, `/profile`, `/admin/users`). Rotating signs all users out — they bounce to `/login` on the next request.

```bash
NEXTAUTH_SECRET=$(openssl rand -base64 32)
```

### NEXTAUTH_URL

Canonical URL of this Next.js instance. Single source of truth for NextAuth callback URLs, origin-check fallback, `metadataBase`, sitemap, and robots.

- **Where used:** `src/lib/auth.ts`, `src/utils/originCheck.ts`, `src/utils/siteUrl.ts`, every internal API call from Python sync scripts
- **User impact:** Every page (NextAuth redirects) and every transactional email link. Misconfigured → emails point to the wrong host.

```bash
NEXTAUTH_URL=http://localhost:3001         # dev
NEXTAUTH_URL=https://growmystocks.com      # prod
```

### NEXT_PUBLIC_SITE_URL

Public-facing URL exposed to the browser bundle. Only set this if the client-side URL differs from the server-side one (e.g. CDN domain in front of a different origin).

- **Where used:** `src/utils/siteUrl.ts` (SITE_URL export), client-side fetch helpers
- **User impact:** Browser-rendered share / canonical URLs, OpenGraph metadata, any client-side fetch that builds absolute URLs. Only matters when the public hostname differs from `NEXTAUTH_URL`.

```bash
NEXT_PUBLIC_SITE_URL=https://cdn.growmystocks.com
```

### ALLOWED_ORIGINS

Comma-separated origins allowed through the `checkOrigin` middleware on API routes. Unset means the origin allowlist is the single value from `NEXTAUTH_URL`.

- **Where used:** `src/utils/originCheck.ts`
- **User impact:** Browser-to-API requests on every authenticated page. Misconfigured → users see CORS errors and blank panels on `/dashboard`, `/portfolio`, `/search`.

```bash
ALLOWED_ORIGINS=https://growmystocks.com,https://staging.growmystocks.com
```

### TRUSTED_PROXIES

Comma-separated list of upstream proxy IPs whose `X-Forwarded-For` header is trusted when extracting the client IP for rate limiting. Prevents IP-spoof bypass by untrusted proxies.

- **Where used:** `src/utils/rateLimitMiddleware.ts` (called by every rate limiter)
- **User impact:** Rate-limit accuracy on `/login`, `/register`, `/forgot-password`, `/contact`, and the prediction API. Misconfigured behind a proxy → everyone shares the proxy's IP and one bad actor triggers 429s for the whole user base.

```bash
TRUSTED_PROXIES=127.0.0.1,::1                    # dev
TRUSTED_PROXIES=10.0.0.0/8,173.245.48.0/20       # prod behind Cloudflare
```

### DEEPMONEY_INTERNAL_SECRET

Shared secret on the `x-api-key` header that cron scripts (`deepmoney_sync.py`, `update_predictions.py`) use to authenticate against internal API routes. Must match between Python and Next.js or scripts get silently redirected to `/login`.

- **Where used:** `src/utils/internalAuth.ts`, every Python sync script
- **User impact:** If the secret breaks, the cron scripts silently fail and the dashboard's DeepMoney Picks, BUY/SELL/DISCOVERY cards, and ETF Holding cards go stale.

```bash
DEEPMONEY_INTERNAL_SECRET=$(openssl rand -hex 32)
```

### SESSION_MAX_AGE

NextAuth JWT session TTL in seconds. Lower forces reauth more often; higher keeps users signed in longer.

- **Where used:** `src/lib/auth.ts` (`session.maxAge`)
- **User impact:** When the TTL expires, the user gets bounced from whichever page they're on to `/login`.

```bash
SESSION_MAX_AGE=604800     # 7 * 24 * 3600 — one week
```

### REDIS_URL

Connection string for the Redis backend used by the distributed rate limiter. Unset or unreachable triggers an in-memory fallback that is not safe across multiple Node instances.

- **Where used:** `src/utils/redisRateLimiter.ts`
- **User impact:** Throttling behavior on `/login`, `/register`, `/forgot-password`, `/contact`. Without Redis on a multi-server deployment, limits are inconsistent and users may see erratic 429s.

```bash
REDIS_URL=redis://127.0.0.1:6379          # dev
REDIS_URL=redis://user:pass@redis:6380/1   # prod
```

---

## Database

All four core variables are required. All tables are in the schema named by `DB_DATABASE`.

| Variable | Required? | Default |
|---|---|---|
| `DB_HOST` | Required | — |
| `DB_USER` | Required | — |
| `DB_PASSWORD` | Required | — |
| `DB_DATABASE` | Required | — |
| `DB_PORT` | Optional | `3306` |

- **Where used:** `src/utils/databaseHelper.ts`, `scripts/deepmoney_sync.py`, `scripts/update_predictions.py`, `scripts/prediction_recorder.py`
- **User impact:** Every dynamic page — `/dashboard`, `/portfolio`, `/search`, `/profile`, `/admin/users`. DB unreachable or wrong credentials = 500 errors across the whole app.

```bash
DB_HOST=localhost
DB_USER=growmystocks_app
DB_PASSWORD=<strong-random-string>
DB_DATABASE=moneygoup
DB_PORT=3306
```

---

## Email (Resend)

The app uses Resend to send transactional email. Each email type has its own API key so they can be rotated and monitored independently.

| Variable | Required? | Default | Email type |
|---|---|---|---|
| `RESEND_API_KEY` | Required for password reset | — | Password reset link |
| `RESEND_REG_API_KEY` | Optional | Falls back to `RESEND_API_KEY` | Registration confirmation |
| `RESEND_REG_FINAL_API_KEY` | Optional | Falls back to `RESEND_API_KEY` | Account approval welcome |
| `RESEND_CONTACT_API_KEY` | Required for contact form | — | Contact form submissions |
| `RESEND_FROM_EMAIL` | Required | — | From: address on all emails |
| `CONTACT_RECIPIENT_EMAIL` | Optional | `digitalkdogg@gmail.com` | To: address for contact form |

### RESEND_FROM_EMAIL

Must be a verified domain in your Resend account or the API rejects every send. Appears on the From: header of every email the platform sends — registration, approval, password reset, and contact form.

```bash
RESEND_FROM_EMAIL=hello@growmystocks.com
```

### Email API Keys

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx           # password reset
RESEND_REG_API_KEY=re_signup_xxxxxxxxxxxxxxxxxxxxxxxx        # registration
RESEND_REG_FINAL_API_KEY=re_welcome_xxxxxxxxxxxxxxxxxxxxxxxx # approval
RESEND_CONTACT_API_KEY=re_contact_xxxxxxxxxxxxxxxxxxxxxxxx   # contact form
```

!!! tip "Silent failures"
    Missing or wrong email API keys cause silent failures — the platform action succeeds (account created, account approved) but the user never receives the email. Monitor server logs for email error entries.

---

## External Data APIs

### FRED_API_KEY

Required for the Federal Reserve Economic Data (FRED) sync. Free to obtain from [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html).

- **Where used:** `scripts/fred_macro_sync.py` only; data is read back via `GET /api/macro/fred`
- **Fetches:** 9 macroeconomic series (PAYEMS, UNRATE, CIVPART, CPIAUCSL, CPILFESL, FEDFUNDS, GDP, T10Y2Y, UMCSENT)
- **User impact:** Dashboard "Macro Climate" bar (`FredMacroCard`) and macro indicator dots on stock detail pages (`MacroScoreBadge`). If the sync hasn't run, these elements show a loading or empty state.

```bash
FRED_API_KEY=your_fred_api_key_here
```

---

## DeepMoney Sync Pipeline + ETF Holdings

### DEEPMONEY_ALGORITHM

The single knob controlling DeepMoney pipeline aggressiveness end-to-end. Float 1.0–10.0; lower = stricter, higher = more permissive.

Resolves through `models/algorithm_presets.json` into five fields: `rankerKeepPct`, `mlpConfidenceFloor`, `volGateFloor`, `analystStrongBuyThreshold`, `signalScoreFloor`. Fractional values (e.g. `1.5`) interpolate linearly; `mlpConfidenceFloor` and `volGateFloor` snap up to the next discrete MLP bucket in `{35, 50, 65, 75}`.

- **Where used:** `src/utils/algorithmPreset.ts`, `src/app/api/prediction/deepmoney/route.ts`, `scripts/deepmoney_sync.py`
- **User impact:** Dashboard DeepMoney Picks widget, DISCOVERY cards on `/dashboard`, per-user ETF Holding cards on `/portfolio`. Lower = fewer cards everywhere; higher = more.
- **Default:** `5`

```bash
DEEPMONEY_ALGORITHM=1.5   # very strict: top ~7% by ranker, effective CS ≥ 75
DEEPMONEY_ALGORITHM=5     # default: top 25%, effective CS ≥ 65
DEEPMONEY_ALGORITHM=8     # loose: top 60%, effective CS ≥ 50
```

!!! note "Replaces retired variables"
    `DEEPMONEY_ALGORITHM` replaces the retired `DEEPMONEY_GPS_VALUE`, `DEEPMONEY_RECOMMENDATION_GPS_VALUE`, `DEEPMONEY_ANALYST_THRESHOLD`, `DEEPMONEY_USE_RANKER_GATE`, and `DEEPMONEY_TIER2_TOPK`.

### ETF_HOLDING_ALGORITHM

The single knob controlling ETF qualification and holdings surfacing aggressiveness. Float 1.0–10.0.

Resolves through `models/etf_holding_presets.json` into: `etfGpsThreshold`, `topNEtfs`, `maxTickers`, `gpsSurfaceValue`, `minPredChangePct`.

- **Where used:** `src/utils/etfHoldingPreset.ts`, `src/utils/etfDiscovery.ts`, `src/utils/etfHoldings.ts`, `src/app/api/stock_data/[ticker]/holdings/route.ts`, `scripts/update_predictions.py`
- **User impact:** ETF Holding cards on `/portfolio` when the user owns an ETF (SPY, QQQ, VGT), the DeepMoney Picks widget, and per-ETF holdings responses.
- **Default:** `5`

```bash
ETF_HOLDING_ALGORITHM=1     # strictest: GPS≥70 to qualify, top 5 ETFs, surface≥75, pred≥3%
ETF_HOLDING_ALGORITHM=5     # default:   GPS≥58, top 11, surface≥60, pred≥1.8%
ETF_HOLDING_ALGORITHM=10    # loosest:   GPS≥45, top 20, surface≥45, pred≥0.5%
```

### ETF_HOLDING_MIN_CONFIDENCE

Baseline minimum MLP confidence (0–100) for an ETF holding to surface as a recommendation. Scaled per-user by aggressiveness. Independent of `ETF_HOLDING_ALGORITHM` — layers on top as a third gate (GPS ∧ pred-change ∧ confidence).

- **Default:** `60`

```bash
ETF_HOLDING_MIN_CONFIDENCE=55      # accept slightly lower-confidence picks
```

### ETF_HOLDING_MAX_BETA

Beta cap on ETF holdings — anything above this is dropped before scoring so the surfaced set isn't dominated by volatile names.

- **Default:** `2.0`

```bash
ETF_HOLDING_MAX_BETA=2      # default
ETF_HOLDING_MAX_BETA=3      # accept higher-beta holdings (more risk)
```

### ETF_HOLDING_STALENESS_HOURS

How old a cached `etf_holding_scores` row can be before `/holdings` re-scores it. Lower = fresher data, more compute; higher = cheaper, more stale.

- **Default:** `4`

```bash
ETF_HOLDING_STALENESS_HOURS=4      # default
ETF_HOLDING_STALENESS_HOURS=24     # cheaper, daily-only refresh
```

---

## Prediction / GPS Scoring

### GPS_PREDICTION_MAX

Saturation point for the `mlpUpside` GPS component. Formula: `mlpUpside = clamp(predicted_change_pct / GPS_PREDICTION_MAX, -1, 1) × 20`.

Lower = component saturates faster (a +3% prediction pegs the full 20 pts); higher = more discriminating across a wider range.

- **Where used:** `src/utils/gps.ts` (`calculateGpsScore` and `adjustGpsForHorizon`), `scripts/update_predictions.py` (`calculate_gps_v3` mirror), `src/app/api/stock_data/[ticker]/holdings/route.ts`
- **User impact:** The GPS number on every card that shows a GPS score — portfolio cards, watchlist cards, BUY/SELL/DISCOVERY cards, the GPS panel on `/search/[ticker]`, and the GpsBreakdownModal.
- **Default:** `3` (code default); `15` (current production)

```bash
GPS_PREDICTION_MAX=3      # tight 3% saturation
GPS_PREDICTION_MAX=15     # wider 15% saturation (current prod)
```

### GPS_BASELINE

Anchor for the dashboard's BUY/SELL/DISCOVERY card rendering.

- BUY threshold = `GPS_BASELINE`
- SELL threshold = `GPS_BASELINE + GPS_SELL_OFFSET`
- DISCOVERY threshold = `GPS_BASELINE + GPS_DISCOVERY_OFFSET`

Strategy `envFloorMultiplier` (safe×1.05, aggressive×0.95) scales BUY and DISCOVERY per user.

- **Where used:** `src/app/api/dashboard/recommendations/route.ts`
- **Default:** `65` (code default); `62` (current production — BUY at 62, scales 65.1 for safe / 58.9 for aggressive)

```bash
GPS_BASELINE=62           # current prod
GPS_BASELINE=75           # stricter: BUY only above 75
```

### GPS_SELL_OFFSET

Offset added to `GPS_BASELINE` to compute the SELL warning threshold. Almost always negative — SELL fires when GPS drops well below the BUY anchor. Not scaled by aggressiveness.

- **User impact:** The SELL warning cards on `/dashboard`. More negative = warnings fire later (deeper score drops required); less negative = more eager warnings.
- **Default:** `-20`

```bash
GPS_SELL_OFFSET=-30       # SELL fires at GPS ≤ baseline - 30
```

### GPS_DISCOVERY_OFFSET

Offset added to `GPS_BASELINE` for the DISCOVERY card threshold.

!!! warning "Code default creates near-empty DISCOVERY section"
    The code default of `+5` puts DISCOVERY above BUY — almost no stocks ever qualify as DISCOVERY. In production this should be set negative (e.g. `-25`) to surface promising stocks the user doesn't own yet.

- **Default:** `+5`

```bash
GPS_DISCOVERY_OFFSET=-25  # DISCOVERY fires at GPS ≥ baseline - 25
```

### GPS_DEEPMONEY_MIN_SCORE

Read-side GPS floor for the dashboard's DeepMoney Picks widget only. Filters which rows of `recommended_stocks` appear in that widget. Independent from the BUY/SELL/DISCOVERY classification.

- **Where used:** `src/app/api/dashboard/deepmoney-picks/route.ts`
- **User impact:** The DeepMoney Picks widget on `/dashboard` only. Does not affect BUY/SELL/DISCOVERY classification elsewhere.
- **Default:** `65`

```bash
GPS_DEEPMONEY_MIN_SCORE=4    # effectively disable the widget filter
GPS_DEEPMONEY_MIN_SCORE=65   # default: only the top tier shows
```

---

## Ollama / AI Take

### OLLAMA_ENABLED

Master switch for all LLM-backed features (NER extraction in the DeepMoney sync, AI Take on `/search/[ticker]`). Must be the exact string `true` to enable — anything else, including unset, disables all LLM calls.

- **Where used:** `src/utils/ollamaClient.ts`, `scripts/deepmoney_sync.py`
- **User impact:** The AI Take panel on `/search/[ticker]` — returns 503 and hides itself when off. Also gates the NER pass in the nightly sync.
- **Default:** `false`

```bash
OLLAMA_ENABLED=true
```

### OLLAMA_BASE_URL

HTTP endpoint of the Ollama server. Override when Ollama runs on a different host, port, or behind a reverse proxy.

- **Where used:** `src/utils/ollamaClient.ts`, `src/instrumentation.ts` (boot-time warmup ping), `scripts/deepmoney_sync.py`
- **Default:** `http://localhost:11434`

```bash
OLLAMA_BASE_URL=http://gpu-box.internal:11434
```

### OLLAMA_MODEL

Default model for generic Ollama calls (NER extraction over article text, other short classification tasks). Feature-specific overrides (`OLLAMA_MODEL_AI_TAKE`) take precedence within their own feature.

- **Where used:** `src/utils/ollamaClient.ts` as the fallback in `GenerateOptions.model`
- **Default:** `llama3.2`

```bash
OLLAMA_MODEL=llama3.2:3b
```

### OLLAMA_TIMEOUT_MS

Default hard timeout for a single Ollama `/api/generate` call. Suited to short classification jobs. AI Take overrides this via `AI_TAKE_TIMEOUT_MS` because paragraph generation takes much longer.

- **Default:** `8000` (8 s)

```bash
OLLAMA_TIMEOUT_MS=15000     # 15s — more tolerant of slow first calls
```

### OLLAMA_MODEL_AI_TAKE

Feature-local model override for the AI Take feature only. Must be a model already pulled locally (`ollama pull`). The model name is included in the AI Take cache `data_hash` so swapping it forces regeneration of every cached take.

- **Where used:** `src/app/api/prediction/[ticker]/ai-take/route.ts`, `src/instrumentation.ts`
- **User impact:** The AI Take card on `/search/[ticker]`. Model choice affects prose quality, tone, and generation latency (8–18 s warm, 12–25 s cold on CPU for gemma3:1b).
- **Default:** `gemma3:1b` (changed 2026-07-24 from `llama3.2` for lower RAM footprint, ~1 GB vs 3.5 GB)

```bash
OLLAMA_MODEL_AI_TAKE=llama3.2:3b      # comparable size, alternative prose style
OLLAMA_MODEL_AI_TAKE=gemma3:4b        # higher quality, ~3.5 GB RAM
```

### AI_TAKE_ENABLED

Kill switch for the AI Take route and its UI panel. Unset defaults to enabled. Set to `off` to hard-disable — the route returns 503 and the `AiTakePanel` hides itself. Also short-circuits the boot warmup ping.

- **Default:** `on` (unset = enabled)

```bash
AI_TAKE_ENABLED=off      # temporarily disable the whole feature
```

### AI_TAKE_CACHE_HOURS

TTL for cached AI Take paragraphs in the `ai_ticker_takes` table. The cache is also keyed on a SHA-256 of the model name + GPS + prediction + news headlines, so entries also invalidate on material data change. This TTL is a secondary expiry that forces refresh even when data is stable.

- **Default:** `12`

```bash
AI_TAKE_CACHE_HOURS=24      # halve daily regeneration traffic
```

### AI_TAKE_RATE_LIMIT_PER_HOUR

How many fresh generations one user can trigger per ticker per hour. Cache hits are always free. A throttled user still gets the cached paragraph back (with a subtle "regeneration limited" italic note) — a 429 is only returned when there is genuinely nothing cached to fall back to.

- **Where used:** In-memory rate bucket keyed on `userId:ticker` — not backed by a DB table; swap to Redis when scaling out.
- **Default:** `1`

```bash
AI_TAKE_RATE_LIMIT_PER_HOUR=3      # allow ~3 regens/hour per ticker per user
```

### AI_TAKE_TIMEOUT_MS

Hard timeout for a single AI Take generation. Sized to allow model cold-loads on CPU-only hardware, which can hit 60–90 s the first time after boot. Warm-model generations typically return in 10–20 s.

- **Default:** `120000` (120 s)

```bash
AI_TAKE_TIMEOUT_MS=180000       # 3 min — very slow first-loads
AI_TAKE_TIMEOUT_MS=45000        # tighter — warm-only, fail fast on cold miss
```

---

## Dashboard Recommendations Rotation

These five variables control the tenure-based rotation system that prevents the same stocks from occupying the dashboard indefinitely.

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_TENURE_ROTATION` | `on` | Master switch for the rotation system |
| `DASHBOARD_TENURE_MAX_DAYS` | `7` | Days before a ticker is rotated out of the fresh pool |
| `DASHBOARD_TENURE_COOLDOWN_DAYS` | `5` | Hold-out days before an evicted ticker can return |
| `DASHBOARD_TENURE_TARGET_CARDS` | `12` | Preferred cap on rotatable BUY cards |
| `DASHBOARD_TENURE_MIN_CARDS` | `8` | Minimum before backfill from the stale pool |

### DASHBOARD_TENURE_ROTATION

Master switch for tenure-based rotation. When on, stocks that have been surfaced too many days in a row get demoted so newly-discovered tickers can rise. Tenure is tracked in the `dashboard_tenure` table (written by `deepmoney_sync.py`). Set to `off` to fall back to a flat GPS-sorted feed.

- **Where used:** `src/app/api/dashboard/recommendations/route.ts`, `src/app/api/dashboard/deepmoney-picks/route.ts`
- **User impact:** The Recommendations section on `/dashboard`. SELL warnings and portfolio-scope cards are always kept regardless of tenure.

```bash
DASHBOARD_TENURE_ROTATION=off     # legacy: flat GPS sort, no rotation
```

### DASHBOARD_TENURE_MAX_DAYS

Consecutive days a ticker can be surfaced before rotation demotes it. Newly-arriving stocks show a green **NEW** pill for the first 3 days. Once a ticker crosses this threshold, it enters a cooldown hold-out.

- **User impact:** How long high-visibility stocks (NVDA, SMCI) stay visible before rotating off. Higher = more stability; lower = fresher daily feed.

```bash
DASHBOARD_TENURE_MAX_DAYS=14      # biweekly rotation
```

### DASHBOARD_TENURE_COOLDOWN_DAYS

How long an evicted ticker stays out of the fresh pool before re-qualifying. Without this cooldown, a demoted ticker would re-qualify on the next sync and never actually rotate. Enforced via `dashboard_tenure.evicted_at`.

```bash
DASHBOARD_TENURE_COOLDOWN_DAYS=3      # shorter break
```

### DASHBOARD_TENURE_TARGET_CARDS

Preferred cap on rotatable BUY cards in the recommendations feed. Portfolio-scope BUYs and all SELL warnings do not count against this cap — they always render. Fresh pool is filled to this size ordered by GPS DESC.

```bash
DASHBOARD_TENURE_TARGET_CARDS=8      # tighter curation
```

### DASHBOARD_TENURE_MIN_CARDS

Safety valve: if the fresh pool has fewer stocks than this number (e.g. rotation demoted most of the qualified set on the same day), the section is backfilled from the stale/evicted pool by GPS DESC so the user never sees an empty grid.

```bash
DASHBOARD_TENURE_MIN_CARDS=4      # allow smaller sections without backfill
```

---

## Quick Reference — Required Variables

The following variables must be set for the application to function correctly. The app will either fail to start or silently break critical features if any are missing.

| Variable | Impact if missing |
|---|---|
| `NEXTAUTH_SECRET` | App fails to start; no authentication |
| `NEXTAUTH_URL` | Auth redirects break; email links point to wrong host |
| `DEEPMONEY_INTERNAL_SECRET` | Sync scripts silently fail; dashboard cards go stale |
| `DB_HOST` | Every data-loading page returns 500 |
| `DB_USER` | Every data-loading page returns 500 |
| `DB_PASSWORD` | Every data-loading page returns 500 |
| `DB_DATABASE` | Every data-loading page returns 500 |
| `RESEND_FROM_EMAIL` | All outbound email rejected by Resend |
| `RESEND_API_KEY` | Password reset emails silently fail |
| `REDIS_URL` | Rate limiting is per-instance only (unsafe on multi-server) |
