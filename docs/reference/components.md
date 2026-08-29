---
purpose: Reference for all 56+ React components — props, dependencies, render behaviour, and the card system discriminated-union architecture.
sources: src/app/components/*.tsx, src/app/components/cards/*.tsx
triggers: Rendered on every page load; components are Server or Client as noted
related: [../business-rules/gps-score.md](../business-rules/gps-score.md), [api-routes.md](api-routes.md), [style-guide.md](style-guide.md)
last_updated: 2026-08-28
---

# Components Reference

GrowMyStocks ships **56+ React components** across 9 logical groups. All components are TypeScript-strict. Client components are marked `'use client'`; everything else is a React Server Component.

!!! note "Section class convention (July 2026)"
    Every major UI region carries a `class="section-<kebab-slug>"` on its parent `<div>`. Where a parent div is not available, a comment marker `{/* section:section-<name> */}` denotes the section start. This makes sections greppable and gives CSS/DevTools/JS a stable handle on every landmark.

---

## Layout and Navigation

### Navigation

**File:** `src/app/components/Navigation.tsx` | Client | Auth-aware

Sticky top navigation bar. Renders a desktop horizontal link row and a mobile slide-in drawer. The profile dropdown (desktop) shows user initials derived from the session name. The mobile drawer includes a focus trap, Escape-key close, and returns focus to the hamburger button on close. The Admin Users link is conditionally shown only when `session.user.role === 'admin'`. Returns `null` on the `/preview` route.

No props — reads session internally via `useSession()`.

### Footer

**File:** `src/app/components/Footer.tsx` | Server

Static server component. Two-column layout: brand description (left) and a "Get in Touch" contact CTA (right). Below the columns, a full investment disclaimer is displayed in a green-tinted strip alongside copyright year and links to Privacy Policy, Terms of Service, and Disclaimer pages.

### RootLayout

**File:** `src/app/layout.tsx` | Server

Root Next.js layout. Applies the Rubik font (weights 400/500/600/700), sets metadata and robots defaults, wraps all pages in `Providers` (NextAuth `SessionProvider`), and delegates chrome rendering to `AppShell`. `AppShell` is a Client component that conditionally renders `Navigation` + `Footer` based on the pathname — hidden on landing/marketing routes. Includes a "Skip to main content" anchor for accessibility.

---

## Dashboard and Sections

### Dashboard

**File:** `src/app/components/Dashboard.tsx` | Client

Top-level orchestrator for the home page (`/dashboard`). Fetches the user's portfolio via `GET /api/user/portfolio` on mount and stores both the portfolio array and the `horizonLabel` returned in `portfolioHorizonLabel` state (default `'1M'`). Determines market open/close status (NYSE hours, weekdays only).

Composes: `MajorIndicesStrip`, `FredMacroCard`, `PortfolioSummary`, `PortfolioSection`, `RecommendationsSection`, `ModelAccuracyWidget`, `WatchlistSection`.

### ModelAccuracyWidget

**File:** `src/app/components/ModelAccuracyWidget.tsx` | Client

Headline analytics widget rendered between the recommendations strip and the watchlist. Fetches `GET /api/analytics/model-accuracy?skip_cache=true` on mount and renders three KPI tiles for the currently-selected horizon:

- **Overall Model Accuracy** — global figure averaged across all resolved predictions and all 4 horizons (green tile)
- **Proximity Accuracy** — per-horizon MAPE-style score (blue tile, shown as "{pct}% ({resolved_count} predictions)")
- **High Accuracy ≥95%** — count of predictions within 5% of actual for the selected horizon (amber tile, "{n}/{resolved_count}")

Four horizon pills (1 Week / 1 Month / 6 Months / 1 Year) switch which horizon block is displayed; selected pill is blue (`bg-blue-600`), default is `1_month`. When the API returns `status: 'insufficient_data'` (fewer than 30 resolved samples), the widget renders a blue info panel.

No props — self-contained.

### PortfolioSection

**File:** `src/app/components/PortfolioSection.tsx` | Client

Renders the user's portfolio as a `StockCardSection` grid. Maps each `PortfolioItem` to a `PortfolioCard` model, forwarding the optional `horizonLabel` prop (default `'1M'`) so the footer reads "{horizonLabel} pred". Reads `predicted_price_horizon` first and falls back to `predicted_price_1m`.

| Prop | Type | Required | Default |
|---|---|---|---|
| `portfolio` | PortfolioItem[] | required | — |
| `horizonLabel` | string | optional | `'1M'` |
| `onRefresh` | () => void | required | — |

### WatchlistSection

**File:** `src/app/components/WatchlistSection.tsx` | Client

Fetches the watchlist from `GET /api/user/watchlist` on mount. Stores `data.horizonLabel` in local state (default `'1M'`) and forwards it into mapped `WatchlistCard` models. Manages a remove-confirmation native dialog and `PurchaseFromWatchlistModal` for moving items to the portfolio.

### RecommendationsSection

**File:** `src/app/components/RecommendationsSection.tsx` | Client

Fetches from `GET /api/dashboard/recommendations` and renders a grid of `MiniDataCard` components with BUY/SELL/PRE-MKT/AFTER-HRS badges. Reads `data.horizonLabel` and renders it in the header pill as "Based on {horizonLabel} prediction". A "Discover more →" link renders under the grid pointing to `/search`.

**Off-market movers (August 2026):** Cards with `scope === 'off_market_mover'` render an orange "⚡ mover" badge and show the extended-hours change % as secondary text. Action badge reads "PRE-MKT" or "AFTER-HRS" based on `offMarketLabel`.

**Tenure (July 2026):** When `rec.consecutiveDays <= 3`, an inline green "NEW" pill renders next to the ticker.

| Prop | Type | Required |
|---|---|---|
| `scopes` | Array<'portfolio' \| 'watchlist' \| 'discovery' \| 'etf_holding' \| 'off_market_mover'> | optional |
| `portfolioEtfTickers` | string[] | optional |

### DeepMoneyPicksSection

**File:** `src/app/components/DeepMoneyPicksSection.tsx` | Client

Fetches from `GET /api/dashboard/deepmoney-picks` and renders four grids:

1. **Off Market Movers** (⚡) — shown only when positive movers exist; client-side filters to positive `metric_value`, sorts descending by magnitude
2. **Top Growth Candidates** (🔥) — hot stocks; tickers already shown as movers are suppressed
3. **Hot ETFs Under $300** (🧺)
4. **Surfaced ETF Holdings** (📡) — shown only when ETF holdings exist; tickers shown as movers are suppressed

Discovery and ETF holdings share a separate 16-slot budget (`TOTAL_CAP = 16`, `HOLDINGS_MAX = 4`) independently of movers.

### StockCardSection

**File:** `src/app/components/StockCardSection.tsx` | Client

Generic typed grid container. Handles loading skeletons, error state with retry, and empty state. Renders cards with a staggered slide-up CSS animation. Grid uses `auto-rows-max` so each row track is sized to the tallest card in that row. Every per-card wrapper has `h-full` so cards stretch to fill their row track.

| Prop | Type | Required | Default |
|---|---|---|---|
| `title` | string | required | — |
| `icon` | string | optional | — |
| `data` | T[] | required | — |
| `renderCard` | (item: T, idx: number) => ReactNode | required | — |
| `loading` | boolean | optional | false |
| `error` | string \| null | optional | null |
| `emptyMessage` | ReactNode | optional | — |
| `columns` | 2 \| 3 \| 4 | optional | 3 |

### PortfolioSummary

**File:** `src/app/components/PortfolioSummary.tsx` | Client

Displays three KPI summary cards: **Total Position Value**, **Daily Earnings** (today's unrealized gain/loss), and **Lifetime Earnings** (unrealized gain/loss vs. cost basis). Delegates display to `SummaryCard`.

| Prop | Type | Required |
|---|---|---|
| `portfolio` | PortfolioItem[] | required |
| `marketStatus` | 'open' \| 'closed' | required |
| `showChart` | boolean | required |
| `onToggleChart` | () => void | required |

### SummaryCard

**File:** `src/app/components/SummaryCard.tsx` | Client

Single KPI display card. Formats a currency value internally.

| Prop | Type | Required |
|---|---|---|
| `label` | string | required |
| `value` | number \| null | required |
| `marketStatus` | 'open' \| 'closed' | required |

### MajorIndicesStrip

**File:** `src/app/components/MajorIndicesStrip.tsx` | Client

Horizontal strip showing live prices and daily change for DJI, S&P 500, NASDAQ, and VIX. Fetches from `GET /api/market/indices` on mount. Polls every 2 minutes **only while the market is open** (polling short-circuits via `if (!getMarketStatus().isOpen) return`). Displays a skeleton while loading.

### GainsBreakdownCard

**File:** `src/app/components/GainsBreakdownCard.tsx` | Client

CSS `conic-gradient` donut chart showing the proportion of unrealized gains, unrealized losses, and cost basis across the portfolio. Displays net P&L percentage in the center.

| Prop | Type | Required |
|---|---|---|
| `portfolioItems` | PortfolioItem[] | required |

---

## Card System

The card system uses a discriminated-union approach. A single `StockCardModel` type has four variants. All cards are routed through `StockCard`, which switches on `card.variant` and dispatches to the appropriate variant view.

!!! note "watchlist variant"
    The `watchlist` variant owns its own outer container (a compact 10px-radius tile per the design mockup) and bypasses `BaseCardShell`. The other three variants are wrapped in `BaseCardShell`.

### StockCardModel — Type Definitions

**File:** `src/app/components/cards/types.ts` | Types only

```typescript
type CardVariant = 'search-trending' | 'deepmoney' | 'portfolio' | 'watchlist'

interface CardBase {
  symbol: string
  companyName: string
  price: number | null
  changePercent: number | null
  changeAmount?: number | null
}

interface PortfolioCard extends CardBase {
  variant: 'portfolio'
  sharesHeld: number | null
  analystFeedback: string | null
  gpsScore?: number | null
  gpsBreakdown?: any | null
  gpsHorizon?: '1_week' | '1_month' | '3_month' | '6_month'
  topAccentColor?: string
  predictedPriceHorizon?: number | null  // renamed from predictedPrice1m
  horizonLabel?: string                  // e.g. "1M", "6M"
  fiftyTwoWeekHigh?: number | null
  logo?: string | null
}

interface WatchlistCard extends CardBase {
  variant: 'watchlist'
  analystFeedback: string | null
  ma6m: number | null
  gpsScore?: number | null
  gpsBreakdown?: any | null
  gpsHorizon?: '1_week' | '1_month' | '3_month' | '6_month'
  predictedPriceHorizon?: number | null  // renamed from predictedPrice1m
  horizonLabel?: string                  // e.g. "1M", "6M"
}

interface DeepmoneyCard extends CardBase {
  variant: 'deepmoney'
  prediction: 'Bullish' | 'Bearish' | 'Neutral' | number | null
  gpsScore: number | null
  gpsBreakdown?: any | null
  timeframeLabel?: string | null
  gpsHorizon?: '1_week' | '1_month' | '3_month' | '6_month'
}

interface SearchTrendingCard extends CardBase {
  variant: 'search-trending'
  hotRating: number | null
}

type StockCardModel = SearchTrendingCard | DeepmoneyCard | PortfolioCard | WatchlistCard
```

### Variant Matrix

| Variant | Shell | Key content |
|---|---|---|
| `portfolio` | `BaseCardShell` + top accent strip | Logo, symbol, price, 3-column metrics (Shares / GPS Score / Rating via `GpsCallLabel`), horizon prediction footer with optional downside-flag triangle |
| `watchlist` | Custom 10px tile (no `BaseCardShell`) | Symbol/name, price, 3-column stats (GPS Score / Rating via `GpsCallLabel` / MA 6M), horizon prediction + chevron |
| `deepmoney` | `BaseCardShell` | Shared `CardHeader` + stacked `CardMetricRow`s: Price, "Predicted Growth {timeframeLabel}", GPS Score (purple accent) |
| `search-trending` | `BaseCardShell` | Symbol/name, price, 3-column stats (GPS Score / Rating via `GpsCallLabel` / MA 6M), horizon prediction footer |

### StockCard

**File:** `src/app/components/cards/StockCard.tsx` | Client | Memoized (`React.memo`)

Entry point for all card renders. Switches on `card.variant`, dispatches to the appropriate variant view, and wraps non-watchlist variants in `BaseCardShell`.

| Prop | Type | Required |
|---|---|---|
| `card` | StockCardModel | required |
| `actions` | CardActionHandlers | optional |
| `className` | string | optional |

### BaseCardShell

**File:** `src/app/components/cards/BaseCardShell.tsx` | Client

Outer wrapper for portfolio, deepmoney, and search-trending variants. Applies hover shadow transition, `rounded-2xl` shape, `w-full h-full` so the shell fills its grid-row track. When `onClick` is provided, sets `role="button"`, `tabIndex={0}`, and handles Enter/Space keyboard activation. Applies the global `focus-ring` utility.

| Prop | Type | Required |
|---|---|---|
| `onClick` | () => void | optional |
| `className` | string | optional |
| `children` | ReactNode | required |

### CardHeader

**File:** `src/app/components/cards/CardHeader.tsx` | Client

Shared header row. Shows ticker symbol, company name, current price, and daily price change with colour-coded background. Two layout variants: `portfolio` (larger type, px-5 padding) and `watchlist` (compact, px-4 padding).

| Prop | Type | Required |
|---|---|---|
| `symbol` | string | required |
| `name` | string | required |
| `price` | number | required |
| `change` | number | required |
| `changePct` | number | required |
| `layout` | 'portfolio' \| 'watchlist' | optional |
| `accentColor` | string | optional |

### CardActions

**File:** `src/app/components/cards/CardActions.tsx` | Client

Flex container for card action buttons. Stops click propagation to prevent triggering the card's own `onClick`. Contains an inner `ActionButton` sub-component with 4 style variants (primary, secondary, danger, neutral) and 2 sizes (sm, md).

### CardMetricRow

**File:** `src/app/components/cards/CardMetricRow.tsx` | Presentational

Simple label/value flex row used inside card bodies.

| Prop | Type | Required |
|---|---|---|
| `label` | string | required |
| `value` | ReactNode | required |

### MiniDataCard

**File:** `src/app/components/cards/MiniDataCard.tsx` | Presentational

Compact display card used in `RecommendationsSection`. Shows label, badge, primary text, secondary text, and sub-label. Background tinting based on `tone` prop ('positive', 'negative', 'neutral'). `label` accepts `string | React.ReactNode` (widened July 2026 to support the "NEW" tenure pill inline with the ticker).

### GpsTooltip

**File:** `src/app/components/GpsTooltip.tsx` | Client

"View score" text trigger that opens `GpsBreakdownModal`. Accepts an optional `variant="card"` prop that flips the modal's headline Rating badge to use variant-B band thresholds.

### GpsCallLabel

**File:** `src/app/components/GpsCallLabel.tsx` | Presentational

Card-only headline Buy/Sell Rating badge. Renders `getCardCallLabel(score)` + `getCardBadgeClass(score)` using variant-B thresholds:

| Score range | Label |
|---|---|
| < 25 | Strong Sell |
| < 45 | Sell |
| < 55 | Hold |
| < 75 | Buy |
| ≥ 75 | Strong Buy |

Used by Portfolio, Watchlist, and Search-Trending cards as the "Rating" column.

---

## Prediction Components

### StockPrediction

**File:** `src/app/components/StockPrediction.tsx` | Client

The main prediction UI on `/search/[ticker]`. Manages the "Generate Prediction" / "Regenerate Prediction" button lifecycle. Posts the enriched stock data to `POST /api/prediction/[ticker]`. Renders the four prediction cards (1w, 1m, 3m, 6m), trajectory chart, confidence badges, and the model performance panel.

**Card accent colours:** 1-week (purple), 1-month (blue), 3-month (emerald), 6-month (green border).

### AiTakePanel

**File:** `src/app/components/AiTakePanel.tsx` | Client

Renders the "Ask AI" analysis panel on `/search/[ticker]`. Streams the AI Take text via `GET /api/prediction/[ticker]/ai-take`. Reads the classification headers (`X-AiTake-Growth-Label`, `X-AiTake-Risk-Label`, `X-AiTake-Quadrant`) and renders three classification badges.

### TechnicalIndicatorsDisplay

**File:** `src/app/components/TechnicalIndicatorsDisplay.tsx` | Client

Renders the four technical indicators (SMA20, SMA50, RSI14, Momentum) on `/search/[ticker]`. Shows current value, signal direction (bullish/bearish/neutral), and contribution to the overall technical score.

### StockSignalPanel

**File:** `src/app/components/StockSignalPanel.tsx` | Client

Renders the composite GPS signal and the bearish downside warning when `breakdown.mlpUpside < 0`. Hosts the "Generate Prediction" / "Regenerate Prediction" action button. Flips to "Regenerate Prediction" when a prefetched prediction exists from the `latest-prediction` endpoint.

### SymbolAccuracyIndicator

**File:** `src/app/components/SymbolAccuracyIndicator.tsx` | Client

Per-symbol accuracy widget on `/search/[ticker]`. Fetches `GET /api/analytics/model-accuracy?symbol=<ticker>` and renders "X/Y correct (Z%)" for the 1-month direction accuracy field.

---

## GPS and Modal Components

### GpsBreakdownModal

**File:** `src/app/components/GpsBreakdownModal.tsx` | Client

Modal dialog showing the full GPS breakdown with labelled component scores, a progress bar per component, and the headline score. Can render in two threshold variants: default (portfolio/industry view) and card (portfolio/watchlist card click-through).

---

## Chart Components

### StockChart

**File:** `src/app/components/StockChart.tsx` | Client

Historical price chart on `/search/[ticker]`. Period selectors (1W, 1M, 6M, 1Y — `button.xs` size class). Fetches OHLCV data from Yahoo Finance for the selected period.

### PortfolioHistoryChart / PortfolioCompareChart

**Files:** `src/app/components/PortfolioHistoryChart.tsx`, `PortfolioCompareChart.tsx` | Client

Portfolio value history charts. Period selectors use the `button.xs` tier (11px, font-weight: normal). `PortfolioHistoryChart` fetches from `GET /api/user/portfolio/historical-value`.

---

## Admin Components

### AdminUsersPage

**File:** `src/app/admin/users/page.tsx` | Client

Admin console for user management. Two-tab interface (Pending Approvals, All Users). Search field, Refresh button, inline role dropdown with confirmation dialog. Calls `GET /api/admin/users` and `PATCH /api/admin/users`. Redirects non-admins to the homepage on load.

---

## Macro and Market Components

### FredMacroCard

**File:** `src/app/components/FredMacroCard.tsx` | Client

Compact macro climate bar rendered just below the indices strip on the dashboard. Displays FRED macroeconomic indicators.

### FredMacroIndicators (full)

Full-width macro indicators section on the dashboard. Displays GDP, inflation, unemployment, and other FRED series.
