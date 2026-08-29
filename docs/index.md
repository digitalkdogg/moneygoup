---
purpose: What GrowMyStocks is, who it is for, and how its core loop works end-to-end.
sources: moneygoup_overview.html, src/utils/strategy.ts, src/app/api/dashboard/recommendations/route.ts
triggers: N/A — static overview
related: [architecture.md](architecture.md), [business-rules/gps-score.md](business-rules/gps-score.md), [system-flows/prediction-pipeline.md](system-flows/prediction-pipeline.md)
last_updated: 2026-08-28
---

# GrowMyStocks — Product Overview

GrowMyStocks (internal codebase name: **MoneyGoUp**) is a personalized investing dashboard. It combines live market data, an in-house AI prediction model, and a unified GPS Score to surface BUY / HOLD / SELL signals against a user's portfolio, watchlist, and a daily AI-curated discovery feed.

!!! note "Core product idea"
    Every personalized number on screen is filtered through the user's own strategy — an `investment_timeframe` (1 week / 1 month / 3 months / 6 months) crossed with an `aggressiveness` setting (safe / neutral / aggressive). Two users looking at the same ticker on the same day can see different scores, different recommendations, and different price targets.

Every AI forecast the platform produces is silently logged and graded against reality. **Direction accuracy** (did the model get up/down right?) is the headline quality metric exposed back to users on the dashboard.

---

## Tech Stack Summary

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 16 (App Router), React 19 | TypeScript strict mode |
| Styling | TailwindCSS | Brand green `#017e3b` |
| Database | MySQL via `mysql2` | Pool + helpers in `src/utils/databaseHelper.ts` |
| Prediction model | Python MLP + LightGBM | `scripts/predict_weighted_analysis.py` spawned by `POST /api/prediction/[ticker]` |
| Auth | NextAuth.js v4 | JWT session, admin-approval gate |
| Market data | `yahoo-finance2` | Quotes, news, fundamentals, history |
| Email | Resend | Registration, approval, password reset |
| AI Take | Ollama (gemma3:1b) | ~60-80 word stock commentary on `/search/[ticker]` |
| Macro data | World Bank API + FRED | GPS macro dampener + dashboard macro panel |

---

## High-Level Architecture

```
          ┌──────────────────────────┐
          │   Browser (React 19)     │
          │   Dashboard / Search /   │
          │   Portfolio / Admin      │
          └────────────┬─────────────┘
                       │  NextAuth session cookie
                       ▼
          ┌──────────────────────────┐        ┌───────────────────────────┐
          │  Next.js 16 (app router) │◀──────▶│  MySQL (mysql2 pool)      │
          │  /api/* route handlers   │        │  users, portfolio,        │
          │  src/utils/strategy.ts   │        │  watchlist, predictions,  │
          │  src/utils/gps.ts        │        │  stock_gps_scores,        │
          └────────────┬─────────────┘        │  user_investment_strategy │
                       │                      └───────────────────────────┘
       spawn (stdin/stdout)                                ▲
                       ▼                                   │
          ┌──────────────────────────┐                     │
          │  Python MLP              │                     │
          │  predict_weighted_       │  writes scores ─────┘
          │  analysis.py             │
          └──────────────────────────┘
                       ▲
                       │  x-api-key (internalAuth.ts)
          ┌──────────────────────────┐
          │  Cron / scheduled jobs   │
          │  update_predictions.py   │
          │  deepmoney_sync.py       │
          └──────────────────────────┘
```

---

## Key User Flow

1. **Sign in.** NextAuth resolves the session. New accounts must be admin-approved before login succeeds.
2. **Dashboard loads.** Portfolio cards, watchlist cards, and a five-bucket recommendations feed are assembled from `/api/dashboard` and `/api/dashboard/recommendations`.
3. **Strategy is resolved.** The user's `investment_timeframe` and `aggressiveness` are read from `user_investment_strategy` via `src/utils/strategy.ts`. Defaults: `neutral` + `1_month`.
4. **GPS scores are patched per-horizon.** Cached scores are read from `stock_gps_scores` and adjusted with `adjustGpsForHorizon` (`src/utils/gps.ts`) so the displayed score matches the user's timeframe.
5. **User drills into a ticker.** `/search/[ticker]` renders the GPS signal panel + AI prediction card. Clicking predict spawns Python inline via `POST /api/prediction/[ticker]`.
6. **Predictions are recorded.** Every successful inference fires `recordPrediction()` as a non-blocking side-effect, writing one row per (symbol, predicted_at) into `prediction_records` for later grading.

---

## Personalization Model

Two axes combine into a single `StrategyConfig` that every personalized route reads:

- **Aggressiveness** — `safe` / `neutral` / `aggressive`. Sets the gating bar: confidence floor, beta cutoff, GPS gate, predicted-change gate, and an env-floor multiplier (1.05× / 1.0× / 0.95×).
- **Investment timeframe** — `1_week` / `1_month` / `3_month` / `6_month`. Selects which predicted-price column to read from `user_stock_predictions`, scales the predicted-change gate, shifts the sell-side threshold, and chooses the DeepMoney ML gate.

!!! tip "Debugging wrong scores"
    If a dashboard number looks wrong for a given user, the explanation almost always lives in their strategy row in `user_investment_strategy`. See [strategy-system.md](business-rules/strategy-system.md) for the full gate matrix.

---

## Recommendation Buckets

The dashboard surfaces five recommendation types in a unified pool (hard-capped at 20 total):

| Bucket | Badge color | Signals | Source |
|---|---|---|---|
| Portfolio | Blue | BUY + SELL | `user_stock_predictions` — owned stocks |
| Watchlist | Amber | BUY only | `user_stock_predictions` — watched stocks |
| Discovery | Purple | BUY only | `recommended_stocks` — AI curated |
| ETF Holding | Teal | BUY only | `etf_stock_recommendations` — top holdings in owned ETFs |
| Off-Market Mover | Orange | Direction only | `recommended_stocks` type=off_market_mover |

See [recommendation-buckets.md](business-rules/recommendation-buckets.md) for full threshold details.

---

## Background Jobs

Three Python scripts keep data fresh:

| Script | Runs | Purpose |
|---|---|---|
| `scripts/deepmoney_sync.py` | Nightly (cron) | DeepMoney discovery — finds stocks, validates with ML, writes `recommended_stocks` |
| `scripts/update_predictions.py` | Nightly (cron) | Refreshes cached predictions + ETF holding scan |
| `scripts/fred_macro_sync.py` | Nightly (cron) | Fetches 9 FRED macro series into `fred_macro_indicators` |

All three authenticate to the Next.js API via `x-api-key: DEEPMONEY_INTERNAL_SECRET` and call `http://localhost:3001` directly to bypass nginx proxy timeouts.

---

## App Pages

| Route | Auth | Purpose |
|---|---|---|
| `/` | Public | Marketing landing page with live model accuracy stats |
| `/dashboard` | Required | Portfolio + watchlist + recommendations |
| `/portfolio` | Required | Full portfolio view with ETF holding cards |
| `/search` | Required | Stock search, trending, earnings calendar |
| `/search/[ticker]` | Required | Single stock detail: GPS, prediction, AI Take, news |
| `/admin/users` | Admin | Approve/reject/role users |
| `/admin/cache` | Admin | Inspect and invalidate in-memory caches |
| `/login` `/register` | Public | Auth pages |

---

## SEO and Public Access

The model accuracy API (`GET /api/analytics/model-accuracy`) is publicly accessible without login, so the marketing landing page can display live prediction accuracy stats to unauthenticated visitors. All legal pages (`/legal/privacy`, `/legal/terms`, `/legal/disclaimer`), the contact form, and sitemap/robots.txt are public.
