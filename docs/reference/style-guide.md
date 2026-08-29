---
purpose: Design system reference — color palette, typography, spacing, button variants, card system, modal standards, accessibility rules, and the utility patterns shared across every page.
sources: src/app/globals.css, tailwind.config.js, src/app/components/BaseCardShell.tsx, src/app/components/WatchlistCardView.tsx, src/app/components/CardActions.tsx, src/app/components/GpsCallLabel.tsx, src/app/components/GpsTooltip.tsx, src/app/components/StockCardSection.tsx
triggers: Applied by all React components; global rules in globals.css govern button typography, heading sizes, and the section-* class convention
related: [reference/components.md](components.md), [business-rules/gps-score.md](../business-rules/gps-score.md)
last_updated: 2026-08-28
---

# Design System

The GrowMyStocks visual language is built on **Tailwind CSS v4** with brand tokens defined in `src/app/globals.css` and a thin config at `tailwind.config.js`. The goal is consistency, accessibility (WCAG 2.1 AA), and a clean financial aesthetic that puts data first.

!!! note "Single source of truth"
    Brand colors, button typography, and heading sizes are defined globally in `globals.css`. Components consume them via Tailwind utility classes. Do not redefine these values per component.

---

## Color Palette

### Brand Greens

Defined in `globals.css` via the `@theme` block. `tailwind.config.js` remaps the `green-700` utility to `#017e3b`.

| Token | Hex | Usage |
|---|---|---|
| Brand Green 700 | `#017e3b` | Primary action, top bar, focus accents. 5.0:1 on white (AA) |
| Brand Green 800 | `#016a32` | Hover state for primary buttons. 6.8:1 on white (AA) |
| Brand Green 600 / `--color-green-600` | `#005a00` | Deepest brand green |
| Brand Green Accent | `#377d13` | Adjusted accent green. 4.5:1 on white (AA) |
| Green Surface 50 | `#f0fdf4` | Sidebar hover / active background |
| Green Surface 100 | `#dcfce7` | Analyst "Strong Buy" badge background |
| Green Accent 200 | `#bbf7d0` | Brand text accent inside the top bar |
| Green Accent 300 | `#86efac` | Active nav underline / sidebar hover border |

### Semantic Colors

| Role | Class | Hex | Usage |
|---|---|---|---|
| Up / Positive | `text-green-600` | `#16a34a` | Price up, positive prediction, gains |
| Down / Negative | `text-red-600` | `#dc2626` | Price down, downside flag, losses |
| Warning / Hold | `text-amber-600` / `amber-800` | `#d97706` | Hold ratings, neutral predictions |
| Focus Ring | `--focus-ring-color` | `#2563eb` | 2px outline + 2px white offset on all interactive elements |
| GPS Score Accent | `text-purple-600` | `#9333ea` | GPS score values inside DeepMoney cards |

### Neutral Surfaces and Text

| Role | Class | Hex |
|---|---|---|
| Card / Surface | `bg-white` | `#ffffff` |
| Page Background | `bg-slate-50` | `#f8fafc` |
| Soft Divider | `border-gray-100` | `#f1f5f9` |
| Default Border | `border-gray-200` | `#e2e8f0` |
| Primary Text | `text-gray-900` | `#1e293b` |
| Secondary Text | `text-gray-500` / `text-gray-600` | `#64748b` |

---

## Typography

**Font stack:** System sans-serif (Inter, SF Pro, Segoe UI).

All headings use `font-weight: 500` — bold and strong are globally remapped to 500 in `globals.css` to keep a calm, modern feel. `letter-spacing: 0.35px` is applied globally via `:root`.

### Heading Scale

| Heading | Size |
|---|---|
| H1 | 36px / 2.25rem |
| H2 | 28px / 1.75rem |
| H3 | 22px / 1.375rem |
| H4 | 18px / 1.125rem |
| H5 | 15px / 0.9375rem |
| H6 | 13px / 0.8125rem |
| Body copy | 16px / 1rem, line-height 1.6 |

### Section Heading (`.section-heading`)

Used for major page sections. Uppercase, 1.75rem, with a 2px brand-green left border and 0.1em tracking.

```html
<h2 class="section-heading">Portfolio Overview</h2>
```

Rendered as: UPPERCASE text, `border-left: 2px solid #017e3b`, `letter-spacing: 0.1em`.

### Card Text Hierarchy

| Role | Size | Classes |
|---|---|---|
| Symbol / ticker | 18–24px | `text-xl/2xl font-bold text-gray-900` |
| Company name | 12–13px | `text-xs/[13px] text-gray-500/600 font-semibold truncate` |
| Price | 18–20px | `text-lg/xl font-bold text-gray-900` |
| Change % | 11–13px | `text-[11px]/[13px] font-semibold {getChangeColor()}` |
| Metric label | 11px | `text-[11px] font-semibold uppercase tracking-wide text-gray-500` |
| Metric value | 14px | `text-sm font-bold text-gray-900` |

---

## Spacing and Layout

Common Tailwind spacing values used consistently across the card layer:

| Value | Usage |
|---|---|
| `gap-6` (24px) | Primary grid gutter for the card grid |
| `gap-2` / `gap-3` (8/12px) | Internal card content gaps |
| `px-4 py-2` / `px-5 py-4` | Card header / body padding |
| `p-5` | Full-size `CardActions` footer padding |
| `px-3 pt-1 pb-3` | Compact `CardActions` footer padding |
| `rounded-lg` (8px) | Buttons |
| `rounded-2xl` (16px) | `BaseCardShell` outer container |
| `rounded-[10px]` | Watchlist tile (custom per mockup) |
| `rounded-full` (9999px) | Bubbles and status pills |

---

## Buttons and Bubbles

### Primary Button

```
bg-green-700 hover:bg-green-800 text-white rounded-lg
```

Uses brand green 700 (`#017e3b`), remapped via `@theme` in `globals.css`. White text, 8px radius, global focus-ring treatment.

### Card Action Buttons (`ActionButton`)

Four variants available in `CardActions.tsx`:

| Variant | Appearance | Example use |
|---|---|---|
| `primary` | Green fill | Buy |
| `secondary` | Green outline | Watch |
| `danger` | Red outline | Sell |
| `neutral` | Gray fill | Remove |

Each variant supports an optional `outline` mode. All card action buttons include the `sm` class, so they render at 12px / weight 500 (see Button Typography below).

### Info Bubbles

Used for status indicators and metadata in headers. Style:

```
bg-white border border-gray-200 rounded-full px-4 py-1.5 text-sm font-semibold text-gray-700 shadow-sm
```

---

## Button Typography

All button font sizes and weights are controlled by a 3-tier global CSS system in `globals.css`. Do not use Tailwind `text-*` or `font-*` classes directly on `<button>` elements — the global rules are the single source of truth. The same tier classes apply to anchor (`<a>`) elements.

| Tier | Selector | Font size | Font weight | Used for |
|---|---|---|---|---|
| 1 — Base | `button` | 14px | normal | Standard form buttons, primary actions |
| 2 — Small | `button.sm`, `a.sm` | 12px | 500 | All card `ActionButton`s (Portfolio and Watchlist) |
| 3 — Extra Small | `button.xs`, `a.xs` | 11px | normal | Chart period selectors (1W / 1M / 6M / 1Y) in `StockChart.tsx`, `PortfolioHistoryChart.tsx`, `PortfolioCompareChart.tsx` |

!!! warning "Do not fight the global rules"
    Do not add Tailwind `text-*` or `font-*` classes directly to `<button>` elements. The global CSS rules take precedence as the single source of truth for button typography.

---

## Cards and Layout

### BaseCardShell (Portfolio / DeepMoney / Search-Trending)

The shared outer container for non-watchlist cards. Renders as `role="button"` and is keyboard-activatable when `onClick` is passed.

```
w-full h-full bg-white border border-gray-100 rounded-2xl shadow-md
hover:shadow-lg hover:-translate-y-1 transition-all duration-200
cursor-pointer flex flex-col overflow-hidden focus-ring
```

Key properties:

- **Radius:** `rounded-2xl` (16px)
- **Shadow:** `shadow-md` → `hover:shadow-lg`
- **Lift:** `hover:-translate-y-1` — the universal "clickable card" affordance applied to every clickable card across the app
- **Border:** 1px `border-gray-100`
- **Layout:** `flex flex-col` + `h-full` so the footer can pin to the bottom via `mt-auto`
- **Focus:** uses the global `.focus-ring` (2px blue outline + 2px white offset)

### WatchlistCardView — Compact Tile

The Watchlist variant owns its own outer container instead of using `BaseCardShell`. Ships as a compact tile with a 10px radius and the same `hover:-translate-y-1` lift.

```
w-full h-full bg-white border border-gray-200 rounded-[10px] px-[18px] pt-4 pb-3.5
cursor-pointer hover:shadow-[0_4px_16px_rgba(0,0,0,0.09)] hover:border-gray-300
hover:-translate-y-1 transition-all duration-200 flex flex-col gap-2.5 focus-ring
```

### Top Accent Strip (Portfolio)

When a brand color is available, the Portfolio card renders a 4px (`h-1`) accent strip at the very top using `card.topAccentColor`. The color is fetched asynchronously via the brand-logo service.

### Card Footer Conventions

- **Pin to bottom:** the footer (or the divider above it) uses `mt-auto` so the bottom row stays anchored when the wrapper stretches to fill the row height.
- **Divider:** `border-t border-gray-100` for Portfolio/DeepMoney; a 1px `bg-gray-100` spacer for Watchlist.
- **Horizon prediction label:** driven by the user's `investment_timeframe`. The card renders `{horizonLabel} Pred` (Watchlist) or `{horizonLabel} pred` (Portfolio). Falls back to `'1M'` only if no horizon is provided. Never hardcode "1M".
- **Chevron:** a right-pointing chevron at the far right of the footer. The Portfolio variant swaps it for a red warning triangle when the model flags downside (`shouldFlagDownside` in `PortfolioCardView.tsx`).

---

## Card Grid Pattern

To make sibling cards in a row stretch to equal height, the grid uses two cooperating utilities: `auto-rows-max` on the grid, plus `h-full` on each wrapper.

```tsx
// StockCardSection.tsx
<div className={`${gridClass} gap-6 auto-rows-max`}>
  {data.map((item, index) => (
    <div key={item.symbol} className="h-full" style={...}>
      {renderCard(item, index)}
    </div>
  ))}
</div>
```

Combined with `flex flex-col` + `mt-auto` on the footer inside each card, this produces an even, magazine-style grid where every card in a row lines up at the bottom. Cards animate in with a staggered `slideUp` keyframe (0.4 s ease-out, 0.05 s delay per index) defined inline in `StockCardSection.tsx`.

---

## Card Variants Matrix

| Variant | Shell | Key content |
|---|---|---|
| `portfolio` | `BaseCardShell` + top accent strip | Logo, symbol, price, 3-column metrics (Shares / GPS Score "View score" / Rating via `GpsCallLabel`), horizon prediction footer with optional downside-flag triangle. Analyst rec demoted to small grey text. |
| `watchlist` | Custom 10px tile (no `BaseCardShell`) | Symbol/name, price, 3-column stats (GPS Score / Rating via `GpsCallLabel` / MA 6M), horizon prediction + chevron. Analyst rec demoted to grey supporting line. |
| `deepmoney` | `BaseCardShell` | Shared `CardHeader` + stacked `CardMetricRow`s: Price, "Predicted Growth {timeframeLabel}", GPS Score (purple accent). |
| `search-trending` | `BaseCardShell` | Symbol/name, price, 3-column stats (GPS Score / Rating via `GpsCallLabel` / MA 6M), horizon prediction footer. Mirrors the Watchlist layout so `/search`-page cards read as a unified family. |

### Sub-components

- `CardHeader` — symbol / company / price / change. Has `variant="watchlist"` and `variant="portfolio"` spacings.
- `CardMetricRow` — label/value row used by DeepMoney and Search-Trending. Label is uppercase 12px gray-500; value is 14px bold.
- `CardActions` — footer with `mt-auto`, top border, and stacked `ActionButton`s. Supports `compact` and `justify` props.
- `BrandLogo` — 40px logo (Portfolio header), falls back to a colored tile when no SVG is available.
- `GpsTooltip` — "View score" text trigger that opens `GpsBreakdownModal`. Accepts `variant="card"` to flip the modal's headline Rating badge to the variant-B band scheme. Used by the Portfolio card; default variant retained by IndustryStocks, RecommendationsSection, and DeepmoneyCardView.
- `GpsCallLabel` — card-only headline Buy/Sell Rating badge (see Badges section below).

---

## Badges and Indicators

### GPS Rating Badge (`GpsCallLabel`)

The headline Buy/Sell call on Portfolio, Watchlist, and Search-Trending cards. Rendered under a **"Rating"** column header.

Color ramp and label come from `getCardBadgeClass(score)` + `getCardCallLabel(score)` in `src/utils/gps.ts`.

**Variant B thresholds** (card-only):

| Score range | Label | Background | Text color |
|---|---|---|---|
| < 25 | Strong Sell | `#fee2e2` | `#991b1b` |
| < 45 | Sell | `#ffedd5` | `#9a3412` |
| < 55 | Hold | `#fef9c3` | `#854d0e` |
| < 75 | Buy | `#ecfdf5` | `#047857` |
| ≥ 75 | Strong Buy | `#dcfce7` | `#166534` |
| null | — | `#f3f4f6` | `#9ca3af` |

Numeric score appears next to the label by default (`showScore=true`) to disambiguate inside the wide 20-point Buy band. Pass `showScore=false` when the score is already displayed in an adjacent column. Null GPS renders the grey "—" placeholder so pre-warm gaps don't break layout.

### Analyst Recommendation (Supporting Text)

Yahoo's `recommendationKey` is no longer the card headline. It is preserved as a small grey supporting line ("Analysts: Strong Buy") directly below the GPS Rating badge. Renders only when an analyst recommendation is present; suppressed otherwise.

### Change and Prediction Color Helpers

Always use these helpers when displaying signed financial values — they guarantee consistent semantic coloring across the app.

```ts
// src/utils/formatters.ts
getChangeColor(value)      // null → text-gray-500 | ≥0 → text-green-600 | <0 → text-red-600
getPredictionColor(value)  // null|0 → text-black | >0 → text-green-600 | <0 → text-red-600
```

### Status Pills

Small colored dot followed by a label inside a white pill:

- Market Open: dot `#22c55e`
- Market Closed: dot `#ef4444`

Pill style: `bg-white border border-gray-200 rounded-full px-4 py-1.5 text-sm font-semibold text-gray-700 shadow-sm`

---

## Common Utility Patterns

### Layout

| Pattern | Usage |
|---|---|
| `flex items-start justify-between` | Card header row (symbol left, price right) |
| `grid grid-cols-3 gap-3` | Three-column metric grid inside cards |
| `truncate max-w-[160-200px]` | Company-name overflow handling |
| `min-w-0 flex-1` | Required on flex children that contain `truncate` content |

### Borders and Dividers

| Pattern | Usage |
|---|---|
| `border-t border-gray-50/100` | Soft footer divider |
| `h-px bg-gray-100` | Inline horizontal rule used in Watchlist |

### Transitions

| Pattern | Usage |
|---|---|
| `transition-all duration-200` | Universal clickable-card hover (shadow + `hover:-translate-y-1` lift). Applies to `BaseCardShell`, `WatchlistCardView`, `SectorExplorer` tiles, and the `<Link>` wrapper in `RecommendationsSection`. |
| `transition-colors duration-200` | Button hover |

!!! tip "Hover affordance rule"
    If the whole tile is clickable, it lifts with `hover:-translate-y-1` plus an expanded shadow. Table rows, presentational mini-cards (`MiniDataCard` in `MarketOverviewCard`), and informational tiles (`IndexCard` in `MajorIndicesStrip`) do **not** lift — the absence of the lift signals that the area is non-navigable.

### Bang-prefix Override for Global Element Rules

Tailwind v4 emits utility classes inside `@layer utilities`. Unlayered CSS in `globals.css` — for example `h3 { font-size: 1.375rem }` — wins over layered CSS regardless of selector specificity. When a Tailwind utility needs to beat a global element rule, prefix it with `!`, which compiles to `!important`.

```tsx
{/* Beats globals.css h3 rule */}
<h3 className="!text-[16px] font-semibold text-blue-600">{article.title}</h3>
<p className="!text-[14px] text-gray-500">{date}</p>
```

Live examples: `src/app/components/StockNews.tsx` lines 61 and 64, `src/app/components/GpsTooltip.tsx` line 32 (`!text-[11px]` for the "View score" trigger).

!!! warning "When to use the bang prefix"
    Reach for this pattern only when overriding a global element rule. Do not use it to fight another utility class — that indicates a specificity or ordering problem elsewhere.

### Site-wide `section-*` Class Convention

Applied 2026-07-12. Every major UI region carries a stable `class="section-<kebab-slug-of-heading>"` on its parent `<div>`. Where a parent div was not available (e.g. a fragment root), an HTML comment marks the section start: `{/* section:section-<name> */}`.

- **Naming:** `section-` prefix followed by the section's heading slugified to kebab-case (e.g. `section-portfolio-summary`, `section-recommendations`, `section-technical-indicators`)
- **Purpose:** gives CSS, DevTools, and JS a stable, greppable handle on every landmark without polluting semantic markup
- **Do not** use `section-*` classes as styling hooks; treat them as identifiers only

```bash
grep -r "section-" src/app/components/    # enumerates every major region
```

---

## Modal Standards

All modals in the application follow a standard accessibility layout enforced across every modal component (`GpsBreakdownModal`, `BuyMoreModal`, `SellModal`).

### Outer Container

```
bg-white rounded-2xl shadow-2xl w-full max-h-[90vh] flex flex-col overflow-hidden
```

- `max-h-[90vh]` — caps the modal at 90% of the viewport height, preventing off-screen overflow on small displays
- `flex flex-col` — establishes vertical flex context so the header stays pinned and only the content area scrolls
- `overflow-hidden` — clips the outer shell; scrolling happens on the inner body only

### Scrollable Body

```
p-6 overflow-y-auto flex-1
```

- `overflow-y-auto` — enables scroll only on the content body, not the full modal
- `flex-1` — allows the body to expand and fill remaining vertical space after the header

### Header (GpsBreakdownModal)

White background (`bg-white`) with dark text (`text-gray-900`). No green-colored header on this modal. Header content: an H3 "Global Performance Metric" heading, a subtitle with symbol / company / version, and a close button. This pattern should be followed for all full-detail modals.

### Portal Rendering

Modals that need to escape z-index stacking contexts (cards, sticky headers) are rendered via `createPortal(content, document.body)`. Currently applies to `GpsBreakdownModal`.

### Keyboard and Backdrop

- Pressing Escape closes the modal (`document.addEventListener('keydown', handler)`)
- Clicking the backdrop (`bg-black/40` overlay) closes the modal
- While open, `document.body.style.overflow = 'hidden'` prevents background scroll, cleaned up in the effect's return function
- Max width: `maxWidth: '480px'` via inline style; `w-full` on the container makes it responsive below 480px

---

## Accessibility Standards

The application targets **WCAG 2.1 Level AA**.

| Standard | Implementation |
|---|---|
| **Contrast** | Brand Green 700 = 5.0:1 on white (AA); Brand Green 800 = 6.8:1. All primary text and interactive elements maintain ≥ 4.5:1. |
| **Focus states** | 2px `#2563eb` outline with 2px offset and white "halo" via `box-shadow` — globally provided by `.focus-ring` and `:focus-visible` rules in `globals.css`. |
| **Skip links** | A "Skip to main content" link (`.skip-link`) is positioned off-screen and slides in on focus. |
| **Keyboard** | `BaseCardShell` and `WatchlistCardView` set `role="button"` + `tabIndex={0}` and handle Enter / Space. |
| **ARIA** | Change-percent values include `aria-label="Price up/down by N%"`; downside-flag icons include both `aria-label` and a `title`; decorative icons set `aria-hidden="true"`. |
| **Semantics** | Strict heading hierarchy (one H1 per page) and consistent uppercase-tracked `.section-heading` treatment for major landmarks. |
