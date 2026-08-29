---
purpose: How the five recommendation buckets work, what gates each bucket applies, and how the unified pool is assembled.
sources: src/app/api/dashboard/recommendations/route.ts, etf_stock_recommendations table, recommended_stocks table, moneygoup_overview.html
triggers: GET /api/dashboard/recommendations — called on every dashboard and portfolio page load
related: [scoring-thresholds.md](scoring-thresholds.md), [strategy-system.md](strategy-system.md), [data-integrations/deepmoney-sync.md](../data-integrations/deepmoney-sync.md)
last_updated: 2026-08-28
---

# Recommendation Buckets

The recommendation engine classifies stocks into five buckets so that user-owned positions, monitored interests, AI discoveries, ETF top-holding breakouts, and real-time off-market movers each get the right level of urgency and validation. Every card on the dashboard belongs to one of these five buckets.

!!! note "August 2026 update"
    A fifth bucket — **Off-Market Mover** — was added. The pool algorithm was redesigned as four independently-capped buckets merged in priority order, hard-capped at **20 total** cards.

---

## Pool Assembly Algorithm

The unified pool is assembled in priority order from four independently-capped buckets:

1. **Pinned** — Portfolio/Watchlist BUY and SELL cards (no cap)
2. **Movers** — Off-Market Mover cards (cap: `DASHBOARD_MOVER_CAP`, default 4)
3. **ETF Holdings** — ETF Holding cards, tenure-filtered (cap: `DASHBOARD_ETF_CAP`, default 4)
4. **Discovery** — AI Discovery cards (fills remaining budget, cap: `DASHBOARD_DISCOVERY_CAP`, default 8)

Results are deduplicated by symbol, then hard-capped at **20 total**. Items are tagged with their scope (`portfolio`, `watchlist`, `discovery`, `etf_holding`, or `off_market_mover`).

---

## Bucket 1 — Portfolio

Positions the user has officially purchased and confirmed. Real financial stakes — signals require the highest precision.

| Property | Value |
|---|---|
| **Signals** | BUY (add to position) and SELL (exit/trim) |
| **Criteria** | `is_purchased = 1 AND user_confirmed = 1 AND shares > 0 AND is_active = 1` |
| **BUY threshold** | +3% predicted change (default, `RECOMMENDATION_PORTFOLIO_POSITIVE_THRESHOLD`) |
| **SELL threshold** | -3% predicted change (default, `RECOMMENDATION_PORTFOLIO_NEGATIVE_THRESHOLD`) |
| **Badge color** | Blue (`bg-blue-100 text-blue-700`) |
| **Cap** | None (always shown) |

---

## Bucket 2 — Watchlist

Stocks the user is actively monitoring but doesn't yet own. Explicitly "confirmed" by the user via "Add to Watchlist".

| Property | Value |
|---|---|
| **Signals** | BUY only |
| **Criteria** | `is_purchased = 0 AND user_confirmed = 1 AND is_active = 1` |
| **Threshold** | +5% predicted change (default, `RECOMMENDATION_WATCHLIST_THRESHOLD`) |
| **Badge color** | Amber (`bg-amber-100 text-amber-700`) |
| **Cap** | None (always shown) |

---

## Bucket 3 — Discovery

High-potential stocks identified automatically by the `deepmoney_sync.py` engine. Appear as "unconfirmed" and don't show in "My Watchlist" until the user interacts with them.

| Property | Value |
|---|---|
| **Signals** | BUY only |
| **Criteria** | `is_purchased = 0 AND user_confirmed = 0 AND is_active = 1` |
| **Discovery logic** | Must survive the full DeepMoney pipeline: `signalScoreFloor` pre-filter + ranker keep-cut + MLP confidence floor + predicted-change gate. All thresholds resolved from `DEEPMONEY_ALGORITHM`. |
| **Target users** | Qualifying stocks are added for every approved user |
| **Badge color** | Purple (`bg-purple-100 text-purple-700`) |
| **Cap** | `DASHBOARD_DISCOVERY_CAP` (default 8) |

---

## Bucket 4 — ETF Holding

Individual stocks that are top holdings inside ETFs the user already owns. When the ML pipeline identifies a high-GPS breakout candidate inside one of the user's ETFs, it surfaces that holding as a direct BUY recommendation with a teal badge.

| Property | Value |
|---|---|
| **Signals** | BUY only |
| **Source** | Written by `scripts/update_predictions.py` during the ETF Holdings scan phase, into `etf_stock_recommendations` |
| **ETF detection** | Each portfolio item is checked against Yahoo Finance's `quoteType`. If `quoteType === 'ETF'`, the item is flagged `is_etf: true` and its top holdings are fetched |
| **Badge color** | Teal (`bg-teal-100 text-teal-700`); scope: `etf_holding`; extra field: `etfTicker` |
| **Card sub-label** | "In {ETF ticker}" (e.g., "In VGT") |
| **Cap** | `DASHBOARD_ETF_CAP` (default 4) |

**Three-gate qualification (all must pass at Level 5 defaults):**

| Gate | Condition |
|---|---|
| GPS | ≥ `preset.gpsSurfaceValue` (L5 default: **60**) — from `ETF_HOLDING_ALGORITHM` |
| Predicted change | ≥ `preset.minPredChangePct` (L5 default: **1.8%**) |
| Confidence | ≥ `ETF_HOLDING_MIN_CONFIDENCE` (default: **60**) |

!!! note "Portfolio-page-only visibility"
    The `etf_holding` scope is only enabled on `/portfolio`. The dashboard home page does not include it. Controlled by the `scopes` prop on `RecommendationsSection`.

---

## Bucket 5 — Off-Market Mover

Stocks with significant pre-market or after-hours price moves detected by the nightly DeepMoney sync. These appear without a GPS score — they are purely price-momentum signals from extended-hours trading.

| Property | Value |
|---|---|
| **Signals** | Direction only — BUY-direction alerts for positive movers; negative moves excluded |
| **Source** | Written by `scripts/deepmoney_sync.py` via `sync_off_market_movers()` at the end of each sync run |
| **Threshold** | Absolute move ≥ 3% (`OFF_MARKET_MIN_CHANGE_PCT = 3.0` — code constant, raised from 1% in August 2026) |
| **Detection window** | Rolling 2-day window (`snapshot_date ≥ CURDATE()-1`) |
| **Market states** | PRE (pre-market 4–9:30 AM ET) and POST/POSTPOST (after-hours). POSTPOST/PREPRE normalized to POST for storage |
| **Action badge** | "PRE-MKT" (pre-market) or "AFTER-HRS" (after-hours) — not "BUY"/"SELL" |
| **Badge color** | Orange (`bg-orange-100 text-orange-700`); scope: `off_market_mover` |
| **GPS** | Always null — secondary text shows the change % instead |
| **Cap** | `DASHBOARD_MOVER_CAP` (default 4) |

---

## UI Behavior on Portfolio Page

The `/portfolio` page derives two values from the portfolio API response:
- `portfolioEtfTickers` — array of symbols where `is_etf === true` (e.g., `['VGT', 'QQQ']`)
- `hasEtfInPortfolio` — boolean derived from `portfolioEtfTickers.length > 0`

When `hasEtfInPortfolio` is true:
```
scopes = ['portfolio', 'watchlist', 'etf_holding']
portfolioEtfTickers = ['VGT', 'QQQ', ...]
```

Inside `RecommendationsSection`, a secondary client-side filter ensures `etf_holding` cards only show when `r.etfTicker` is in the `portfolioEtfTickers` set. This prevents watchlist-only ETF holding cards from leaking onto the portfolio grid.

---

## Environment Variables

| Variable | Default | Applies to |
|---|---|---|
| `RECOMMENDATION_PORTFOLIO_POSITIVE_THRESHOLD` | +3% | Portfolio (BUY) |
| `RECOMMENDATION_PORTFOLIO_NEGATIVE_THRESHOLD` | -3% | Portfolio (SELL) |
| `RECOMMENDATION_WATCHLIST_THRESHOLD` | +5% | Watchlist and Discovery |
| `ETF_HOLDING_ALGORITHM` | 5 | ETF Holding — single preset knob (1–10) |
| `ETF_HOLDING_MIN_CONFIDENCE` | 60 | ETF Holding — confidence gate |
| `ETF_HOLDING_MAX_BETA` | 2.0 | ETF Holding — beta cap |
| `ETF_HOLDING_STALENESS_HOURS` | 4 | ETF Holding — cache freshness |
| `DASHBOARD_MOVER_CAP` | 4 | Off-Market Mover — pool cap |
| `DASHBOARD_ETF_CAP` | 4 | ETF Holding — pool cap |
| `DASHBOARD_DISCOVERY_CAP` | 8 | Discovery — pool cap |

!!! warning "Retired env vars"
    Replaced by `ETF_HOLDING_ALGORITHM`: `ETF_HOLDING_GPS_SURFACE_VALUE`, `ETF_HOLDING_MIN_PRED_CHANGE`, `ETF_HOLDING_MAX_TICKERS`, `ETF_HOLDING_TOP_N`, in-code `ETF_GPS_THRESHOLD`.
