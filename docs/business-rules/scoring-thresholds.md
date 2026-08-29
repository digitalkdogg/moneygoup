---
purpose: What numeric thresholds gate every BUY / SELL / HOLD decision across the platform, and where each threshold lives in code.
sources: business_rules.html, src/utils/strategy.ts, src/app/api/dashboard/recommendations/route.ts, src/utils/gps.ts
triggers: Applied at dashboard read time — every time /api/dashboard/recommendations is called
related: [gps-score.md](gps-score.md), [strategy-system.md](strategy-system.md), [recommendation-buckets.md](recommendation-buckets.md)
last_updated: 2026-08-28
---

# Scoring Thresholds

This page is the authoritative reference for every numeric gate that determines whether a stock shows a BUY, SELL, or HOLD signal on the dashboard.

!!! warning "Read-time application"
    All thresholds are applied at **dashboard read time** (`/api/dashboard/recommendations`), not during the DeepMoney sync. The sync produces a single global candidate pool; individual user strategy multipliers are applied when that user loads `/dashboard`.

---

## GPS Label Thresholds (universal, all surfaces)

Used by `getGpsLabel()` in `src/utils/gps.ts`:

| GPS Range | Label |
|---|---|
| ≥ 80 | Strong Buy |
| ≥ 65 | Buy |
| ≥ 45 | Hold |
| ≥ 30 | Sell |
| < 30 | Strong Sell |

These bands are **independent** of the per-user BUY/SELL thresholds. They are the universal label scale shown on the stock detail page and in modal headers.

---

## Aggressiveness Gates (per-user, at read time)

Source: `AGGRESSIVENESS_GATES` in `src/utils/strategy.ts`

| Gate | safe | neutral | aggressive | Description |
|---|---|---|---|---|
| `confidenceFloor` | 65 | 50 | 35 | Minimum AI model confidence (0–100) to include a stock |
| `betaCutoff` | 1.5 | 2.0 | 3.5 | Maximum beta coefficient; filters volatile stocks |
| `gpsGate` | 75 | 65 | 55 | Minimum GPS for a BUY recommendation |
| `predChangeGate` (1m baseline) | 3.0% | 1.5% | 0.5% | Base minimum predicted price change (%) |
| `envFloorMultiplier` | ×1.05 | ×1.00 | ×0.95 | Applied to env-driven GPS thresholds |

**`envFloorMultiplier` application:** The env-driven BUY threshold (e.g., `GPS_RECOMMENDATION_BUY_THRESHOLD = 65`) is multiplied by this value. Example: safe aggressiveness → effective threshold = 65 × 1.05 = 68.25. The SELL threshold is **not** scaled — sells use `timeframe.sellThresholdShift` instead.

---

## Timeframe Multipliers (per-user, stacked on aggressiveness gates)

Source: `TIMEFRAME_CONFIG` in `src/utils/strategy.ts`

| Timeframe | `predChangeMultiplier` | `sellThresholdShift` | `mlGate` |
|---|---|---|---|
| `1_week` | 0.5× | −2 | 0.5% |
| `1_month` | 1.0× | 0 | 1.5% |
| `3_month` | 1.25× | +2 | 3.0% |
| `6_month` | 1.5× | +3 | 5.0% |

**Effective predChange gate** = `gates.predChangeGate × timeframe.predChangeMultiplier`

Examples:
- Safe + 6-month: 3.0% × 1.5 = 4.5% minimum predicted change
- Aggressive + 1-week: 0.5% × 0.5 = 0.25% minimum predicted change

**`sellThresholdShift`** is *added* to the env-driven GPS SELL threshold. Positive shift (long-horizon) raises the bar so users hold longer; negative shift (short-horizon) fires SELL warnings sooner.

---

## Recommendation Bucket Thresholds

Source: `src/app/api/dashboard/recommendations/route.ts`

### Portfolio Bucket (BUY and SELL)

| Signal | Condition |
|---|---|
| BUY | GPS ≥ `GPS_BASELINE × envFloorMultiplier` AND `predicted_change_pct ≥ predChangeGate × predChangeMultiplier` AND `confidence ≥ confidenceFloor` AND `beta ≤ betaCutoff` |
| SELL | GPS ≤ (`GPS_BASELINE + GPS_SELL_OFFSET + sellThresholdShift`) |

Legacy env vars still honored:
- `RECOMMENDATION_PORTFOLIO_POSITIVE_THRESHOLD` — default +3%
- `RECOMMENDATION_PORTFOLIO_NEGATIVE_THRESHOLD` — default -3%

### Watchlist Bucket (BUY only)

| Condition |
|---|
| `is_purchased = 0 AND user_confirmed = 1 AND is_active = 1` |
| Threshold: `RECOMMENDATION_WATCHLIST_THRESHOLD` (default +5%) |

### Discovery Bucket (BUY only)

| Condition |
|---|
| `is_purchased = 0 AND user_confirmed = 0 AND is_active = 1` |
| GPS ≥ `GPS_RECOMMENDATION_DISCOVERY_THRESHOLD × envFloorMultiplier` |
| Must survive full DeepMoney pipeline |

### ETF Holding Bucket (at Level 5 defaults)

All three must be met:
1. GPS ≥ `preset.gpsSurfaceValue` (L5 default: **60**) — resolved from `ETF_HOLDING_ALGORITHM`
2. `predicted_change_pct ≥ preset.minPredChangePct` (L5 default: **1.8%**)
3. `confidence_score ≥ ETF_HOLDING_MIN_CONFIDENCE` (default: **60**)

---

## DeepMoney Discovery Pipeline Gates

These are applied server-side inside `POST /api/prediction/deepmoney` before the Python sync even sees candidates. They are resolved from `DEEPMONEY_ALGORITHM` via `models/algorithm_presets.json`:

| Field | Level 1 (strictest) | Level 5 (default) | Level 10 (loosest) |
|---|---|---|---|
| `rankerKeepPct` | ~7% top by rank | 25% | 60% |
| `mlpConfidenceFloor` | 75 | 60 (snapped up from 60) | 30 |
| `volGateFloor` (beta > 2.5) | 75 | 65 | 35 |
| `analystStrongBuyThreshold` | Higher | Medium | Lower |
| `signalScoreFloor` | Higher | Medium | Lower |

!!! tip "Changing DEEPMONEY_ALGORITHM"
    Move the whole pipeline in one direction with one number: `DEEPMONEY_ALGORITHM=1.5` (very strict) → `DEEPMONEY_ALGORITHM=5` (default) → `DEEPMONEY_ALGORITHM=8` (loose). The MLP/vol floors snap UP to the next discrete bucket in {35, 50, 65, 75}.

---

## Rate Limits

| Route | Limiter | Window & Cap |
|---|---|---|
| `POST /api/auth/register` | `registerLimiter` | 5 / 15 min per IP + username |
| `POST /api/auth/forgot-password` | `forgotPasswordLimiter` | 3 / 15 min per IP |
| `POST /api/auth/reset-password` | `resetPasswordLimiter` | 5 / 15 min per IP |
| Login (NextAuth authorize) | `loginLimiter` | 10 / 15 min per IP |

Internal requests (valid `x-api-key` header) bypass all rate limits.

---

## Prediction Output Clamping

After the Python model produces raw predictions, `_sanitize_predictions()` in `scripts/predict_core.py` applies vol-scaled per-horizon caps before the numbers are stored:

| Horizon | Base cap | Vol scaling |
|---|---|---|
| 1w | ±15% | × max(1, min(2.5, realized_vol_60d / 0.30)) |
| 1m | ±30% | Same scaling |
| 3m | ±60% | Same scaling |
| 6m | (via 3m trajectory) | Same scaling |

Confidence is demoted to **25** only when the clamp catches a real outlier. Coherent extrapolation (both 3m + 6m push against their vol-scaled caps in the same direction) keeps the model's own confidence and sets `at_model_ceiling_*` flags for the UI's directional pill.
