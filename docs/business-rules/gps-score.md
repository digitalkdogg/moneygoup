---
purpose: How the GPS Score is calculated, what each component means, and how to tune it via environment variables.
sources: src/utils/gps.ts, scripts/update_predictions.py (calculate_gps_v3), stock_gps_scores table, user_stock_predictions table
triggers: Score runs every time a prediction is saved via POST /api/prediction/save or scripts/deepmoney_sync.py.
related: [scoring-thresholds.md](scoring-thresholds.md), [system-flows/prediction-pipeline.md](../system-flows/prediction-pipeline.md), [data-integrations/model-training.md](../data-integrations/model-training.md)
last_updated: 2026-09-05
---

# GPS Score (v3.0)

The **GPS Score** (GrowMyStocks Prediction Score) is a 0–100 composite metric that answers: *how compelling is this stock right now?* Version 3.0 expanded from 6 to **8 components**, adding a dedicated Technical Signal component (up to 17 pts) and an Analyst Consensus Rating (up to 9 pts).

!!! note "GPS v3.0 at a glance"
    8 components, 100 points total. ML prediction (25 pts + 5 pts confidence), technical signals (17 pts), fundamentals (24 pts), analyst inputs (21 pts), 52-week momentum (8 pts). TypeScript and Python implementations are kept in exact parity. The score is the plain sum of the 8 components — no post-hoc rescaling. A prior percentile-calibration step (`scripts/recalibrate_gps_scores.ts`) was removed 2026-09-05: it was compensating for scoring-formula bugs (see the horizon-mismatch and null-close notes below) rather than a real need to rescale, and made the score opaque (the headline number stopped matching the sum of the components shown in the breakdown UI). With those bugs fixed, the raw additive score is used directly.

!!! warning "This component table was out of date until 2026-09-03"
    The table and weights below previously documented pre-`dd07eb0` values (mlpUpside 20, technicalSignal 20, priceChange52w 10). The current production weights are mlpUpside 25, mlpConfidence 5, revenueGrowth 12, earningsGrowth 12, technicalSignal 17, analystUpside 12, analystConsensus 9, priceChange52w 8 — see `src/utils/gps.ts:34-42`. Keep this file and `src/utils/gps.ts` in lockstep going forward.

---

## Score Ranges and Labels

These thresholds are used by `getGpsLabel()` in `src/utils/gps.ts`:

| Range | Label | Interpretation |
|---|---|---|
| 80–100 | **Strong Buy** | High-conviction signal across all components. Top of the DeepMoney discovery shortlist. |
| 65–79 | **Buy** | Strong fundamentals and positive AI/technical outlook. Qualifies for dashboard recommendations. |
| 45–64 | **Hold** | Mixed picture. May appear in discovery depending on env thresholds. |
| 30–44 | **Sell** | Below-average signal across most components. Below standard recommendation thresholds. |
| 0–29 | **Strong Sell** | Weak fundamentals and/or a negative AI outlook. Not surfaced in recommendations. |

### Card-Only Label Variant (variant B)

Portfolio, watchlist, and trending cards use a tighter scheme via `getCardCallLabel(score)` to make a more decisive rating at a glance:

| Range | Label |
|---|---|
| 75–100 | Strong Buy |
| 55–74 | Buy |
| 45–54 | Hold |
| 25–44 | Sell |
| 0–24 | Strong Sell |

!!! warning "Different labels on cards vs. stock detail page"
    A stock scored 60 shows **Buy** on a portfolio card but **Hold** on the stock detail GPS panel. This is deliberate. The canonical scheme (30/45/65/80 thresholds) aligns with env-var thresholds used by the recommendations engine and must not drift.

---

## Score Components (v3.0 — 8 components)

### Component 1 — ML Predicted Change (horizon-dependent)
**Max 25 pts**

```
min(max(predictedChangePct / HORIZON_ML_PREDICTION_CEILING_PCT[horizon], 0), 1) × 25
```

Percentage price change predicted by the MLP model for the given horizon. Scaled against `HORIZON_ML_PREDICTION_CEILING_PCT[horizon]` (`src/utils/horizons.ts`) — a fixed per-horizon ceiling, anchored to that horizon's own empirical 75th-percentile predicted change (measured 2026-09-05: 1w 5.5%, 1m 2.3%, 3m 24.1%, 6m 24.0%). A prediction at or beyond that ceiling earns the full 25 pts. A negative prediction floors at 0 — same treatment as every other component here (revenue growth, earnings growth, analyst upside); it does **not** subtract points scaled by how bad the decline is, so a -5% and a -99% prediction both score 0 here. A negative prediction still sets `bearishSignal = true`. **Patched by `adjustGpsForHorizon`** when displaying for a non-1m horizon, using the same per-horizon ceiling table.

!!! note "Replaced GPS_PREDICTION_MAX 2026-09-05"
    This component previously used a single `GPS_PREDICTION_MAX` env constant (production value 25%), naively scaled by horizon length for non-1-month horizons. That constant was itself ~10x higher than the model's actual 1-month output (p90 ≈ 5%) — the single biggest contributor to raw scores clustering well below 80 — and scaling it linearly by horizon length didn't track how much predicted-move magnitude actually grows with horizon (a 6-month prediction is far more than 6x a 1-month one). The per-horizon ceiling table replaces both: each horizon anchors to its own real distribution instead of a scaled guess. Revisit periodically as the model/universe shifts.

### Component 2 — AI Model Confidence (horizon-dependent)
**Max 5 pts**

```
(confidenceScore / 100) × 5
```

The model's self-reported confidence in its prediction (0–100). **Also patched by `adjustGpsForHorizon`** with the per-horizon confidence score.

### Component 3 — Revenue Growth YoY
**Max 12 pts**

```
min(max(revenueGrowthPct / 0.30, 0), 1) × 12
```

30% YoY revenue growth earns the full 12 pts. Shrinking revenue scores 0. Horizon-independent.

### Component 4 — Earnings Growth YoY
**Max 12 pts**

```
min(max(earningsGrowthPct / 0.25, 0), 1) × 12
```

25% YoY EPS growth earns the full 12 pts. Horizon-independent.

### Component 5 — Technical Signal
**Max 17 pts**

```
min(max((technicalScore + 14) / 28, 0), 1) × 17
```

Raw technical score from `calculateTechnicalIndicators()`, ranging **-14 to +14**. Mapped linearly to 0–20 pts. Computed server-side in `/api/stock_data/[ticker]/data` and returned as `technicalScore` at the payload root.

### Component 6 — Analyst Price Target Upside
**Max 12 pts**

```
min(max(analystUpside / 0.30, 0), 1) × 12
```

Consensus analyst price target vs. current price. 30% upside earns the full 12 pts.

### Component 7 — Analyst Consensus Rating
**Max 9 pts**

Fixed-point lookup based on Yahoo Finance `financialData.recommendationKey`:

| recommendationKey | Points |
|---|---|
| `strongBuy` / `strong_buy` | 9 |
| `buy` | 7 |
| `hold` (default if missing) | 4 |
| `underperform` | 2 |
| `sell` | 0 |

### Component 8 — 52-Week Momentum
**Max 8 pts**

```
min(max(priceChange52w / 0.20, 0), 1) × 8
```

Trailing 52-week price return. 20% appreciation earns the full 8 pts.

**Total maximum: 25 + 5 + 12 + 12 + 17 + 12 + 9 + 8 = 100 pts**

---

## Full Formula (TypeScript canonical — `src/utils/gps.ts`)

```typescript
const predictionMax = HORIZON_ML_PREDICTION_CEILING_PCT[options.horizon ?? '1_month']

const m1 = Math.min(Math.max((prediction.predictedChangePct1m || 0) / predictionMax, 0), 1) * 25
const m2 = ((prediction.confidenceScore || 0) / 100) * 5
const m3 = Math.min(Math.max((metrics.revenueGrowthPct || 0) / 0.3, 0), 1) * 12
const m4 = Math.min(Math.max((metrics.earningsGrowthPct || 0) / 0.25, 0), 1) * 12
const rawTech = metrics.technicalScore ?? 0
const m5 = Math.min(Math.max((rawTech + 14) / 28, 0), 1) * 17
const m6 = Math.min(Math.max((metrics.analystUpside || 0) / 0.3, 0), 1) * 12
const m7 = CONSENSUS_POINTS[metrics.recommendationKey ?? ''] ?? CONSENSUS_POINTS.hold
const m8 = Math.min(Math.max((metrics.priceChange52w || 0) / 0.2, 0), 1) * 8

const totalGps = m1 + m2 + m3 + m4 + m5 + m6 + m7 + m8
return {
  score: parseFloat(Math.min(Math.max(totalGps, 0), 100).toFixed(1)),
  bearishSignal: (prediction.predictedChangePct1m || 0) < 0,
  breakdown: { mlpUpside, mlpConfidence, revenueGrowth, earningsGrowth,
               technicalSignal, analystUpside, analystConsensus, priceChange52w }
}
```

!!! warning "Python/TypeScript parity"
    The Python equivalent is `calculate_gps_v3()` in `scripts/update_predictions.py`. Both must stay in lockstep. If you change the formula in one file, update the other immediately.

---

## Horizon Adjustment — `adjustGpsForHorizon`

GPS is calculated once per stock against the 1-month prediction and cached in `stock_gps_scores`. When a user's investment timeframe differs from 1-month, dashboard routes *patch* the cached breakdown at read time:

```typescript
export function adjustGpsForHorizon(
  breakdown: GpsBreakdown,
  predictedChangePctForHorizon: number,
  confidenceScoreForHorizon?: number,
): { breakdown: GpsBreakdown; score: number }
```

The helper patches **both** horizon-dependent components (`mlpUpside` and `mlpConfidence`). The other 6 components pass through unchanged. When `confidenceScoreForHorizon` is undefined, the cached baseline confidence is preserved (back-compat with legacy rows).

**Data flow on the dashboard:**

1. The model persists per-horizon outputs on `user_stock_predictions` as `predicted_change_pct_{1w,1m,3m,6m}` and `confidence_score_{1w,1m,3m,6m}`.
2. Dashboard routes select these columns directly.
3. Each route loads the cached baseline breakdown from `stock_gps_scores` and calls `adjustGpsForHorizon(baselineBreakdown, storedChangePct, storedConfidence)`.
4. For legacy rows where per-horizon columns are NULL, the route falls back to a price-derived delta.

---

## Bearish Signal

Every `GpsResult` includes a `bearishSignal: boolean` field. Set to `true` when `predictedChangePct1m < 0`.

Where it surfaces:
- **Stock detail Signal Panel** — red triangular warning banner: *"AI model predicts downside — the MLP signal is negative for this stock's 1-month outlook."*
- **Portfolio card** — "AI model predicts downside" warning badge when `predictionChange < 0`.
- **Python sync script** — prints a `[gps] BEARISH SIGNAL` log line.

!!! tip "Bearish signal ≠ Sell rating"
    A stock with strong fundamentals, positive technicals, and strong analyst consensus can still score in the Buy range even with a slightly negative ML prediction. The bearish signal is informational, not a hard gate.

---

## Storage and Write Path

| Table | Purpose |
|---|---|
| `stock_gps_scores` | One row per stock, always the latest score (primary read source). Baseline reflects the 1-month horizon. |
| `stock_gps_score_history` | Append-only log; a new row is written only when the score changes. |

**Write optimization — skip if unchanged:** Before every GPS write, the incoming score is compared to the stored value at 1 decimal-place precision. If they match, all three writes are skipped (upsert to `stock_gps_scores`, insert to `stock_gps_score_history`, GPS sync to `recommended_stocks`).

| Write source | Trigger |
|---|---|
| `POST /api/prediction/save` | User-triggered prediction or background sync via API |
| `scripts/deepmoney_sync.py` | Scheduled discovery cycle (direct DB write) |

---

## Configuration

!!! note "GPS_PREDICTION_MAX no longer used here"
    As of 2026-09-05 the 8-component formula uses `HORIZON_ML_PREDICTION_CEILING_PCT` (fixed per-horizon values, see Component 1 above) instead. `GPS_PREDICTION_MAX` is still read by the ETF holdings threshold-recovery logic in `src/app/api/stock_data/[ticker]/holdings/route.ts` (a separate, older 20-pt-weight formula) — that consumer wasn't in scope for this change and is now inconsistent with the ceiling used elsewhere; worth reconciling separately.

| Variable | Default | Effect |
|---|---|---|
| `GPS_DEEPMONEY_MIN_SCORE` | `65` | Minimum GPS to include a stock in the DeepMoney Picks widget (`GET /api/dashboard/deepmoney-picks`). |
| `GPS_RECOMMENDATION_BUY_THRESHOLD` | `65` | GPS required to surface a BUY recommendation for portfolio/watchlist stocks. |
| `GPS_RECOMMENDATION_SELL_THRESHOLD` | `45` | GPS below which a portfolio stock triggers a SELL recommendation. |
| `GPS_RECOMMENDATION_DISCOVERY_THRESHOLD` | `70` | GPS required for discovery-scope stocks to appear as BUY recommendations. |
| `GPS_BASELINE` | `65` | Anchor for dashboard BUY/SELL/DISCOVERY card rendering; multiplied by strategy `envFloorMultiplier`. |
| `GPS_SELL_OFFSET` | `-20` | Added to `GPS_BASELINE` to compute the SELL threshold. |
| `GPS_DISCOVERY_OFFSET` | `+5` | Added to `GPS_BASELINE` for the DISCOVERY card threshold. |

---

## Where GPS Appears

| Surface | Notes |
|---|---|
| Stock detail Signal Panel (`/search/[ticker]`) | Score + top-3 breakdown bars + "View score" button → `GpsBreakdownModal` |
| Watchlist cards | Horizon-adjusted via `adjustGpsForHorizon`; "View score" button |
| Portfolio cards | Horizon-adjusted; shows bearish downside badge when `predictionChange < 0` |
| Dashboard recommendations | Horizon-adjusted; macro adjustment up to ±3 pts |
| DeepMoney Picks widget | Filtered by `GPS_DEEPMONEY_MIN_SCORE`; sorted descending |
| `GpsBreakdownModal` | Shows all 8 components with progress bars; opens from any "View score" button |
