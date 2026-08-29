---
purpose: The complete end-to-end execution path from user clicking "Predict" to a prediction result displayed on screen and persisted to the database.
sources: src/app/api/prediction/[ticker]/route.ts, scripts/predict_weighted_analysis.py, scripts/predict_core.py, src/utils/predictionRecorder.ts, src/app/components/StockPrediction.tsx
triggers: User clicks Predict button on /search/[ticker]; also triggered by update_predictions.py batch job
related: [../data-integrations/model-training.md](../data-integrations/model-training.md), [../business-rules/gps-score.md](../business-rules/gps-score.md), [../reference/api-routes.md](../reference/api-routes.md)
last_updated: 2026-08-28
---

# AI Prediction Pipeline

The prediction system (v3.5) produces 1-week, 1-month, 3-month, and 6-month price targets with Monte Carlo uncertainty bands and a trajectory chart. **A single Python invocation returns all four horizons at once.**

!!! note "August 2026 — Horizon migration"
    The 1-year prediction horizon was retired and replaced by 3-month. Active horizons: 1w / 1m / 3m / 6m. `_1y` DB columns still exist but are no longer written.

---

## End-to-End Lifecycle

1. **UI trigger.** User clicks the Predict button in `StockPrediction.tsx` on `/search/[ticker]`. The component first fetches enriched data from `GET /api/stock_data/[ticker]/data`, then posts the resulting JSON body to `POST /api/prediction/[ticker]`.

2. **Guard chain.** The route validates: origin, session, approval status, lookup quota, ticker format, body shape (`historicalData` length ≥ 365 + `stockMetrics` object), and the `outlook` query value. Internal calls (`x-api-key`) skip session + lookup checks.

3. **Cache check.** Unless `?refresh=true` is set, the route consults the in-memory `predictionCache` at key `{ticker}_{outlook}`. On a hit, the Python script is skipped entirely — but GPS is still computed live from the cached result because GPS is per-user.

4. **Concurrency gate.** If the cache misses, the route acquires a slot from `predictionSemaphore` (503 Busy if full).

5. **Python model.** A temp JSON file is written and `scripts/predict_weighted_analysis.py` is spawned. The script returns all four horizons in one call: `predicted_price_{1w,1m,3m,6m}`, `predicted_change_pct_{1w,1m,3m,6m}`, `confidence_score_{1w,1m,3m,6m}`, trajectory chart, accuracy metrics, and regime info.

6. **Analytics record.** Immediately after Python returns, `recordPrediction()` fires once (fire-and-forget) to insert a row into `prediction_records`.

7. **Cache write.** The route populates legacy `predicted_price` / `predicted_change_pct` / `confidence_score` keys based on the requested `outlook` and stores the result in `predictionCache`.

8. **Dual GPS computation.** `buildResponse()` computes:
   - **Neutral 1m baseline GPS** — used for global persistence to `stock_gps_scores`
   - **User-horizon GPS** — returned to the caller, based on their `investment_timeframe`

9. **Async persistence.** `savePredictionAsync()` POSTs to `/api/prediction/save` with all four horizon prices, all eight per-horizon stats, and the **baseline 1m GPS**. This call is fire-and-forget; the user response does not wait for it.

10. **Save route.** `/api/prediction/save` upserts `user_stock_predictions` (per-user, prices + per-horizon stats) and upserts `stock_gps_scores` + appends `stock_gps_score_history` with the GPS baseline (global, one row per stock).

11. **Response.** The caller receives the full model output merged with `source`, `gps_score` (horizon-matched), `gps_breakdown`, and `gps_horizon`.

---

## Strategy Integration

A user's investment strategy has two dimensions: **aggressiveness** and **investment timeframe**. Both are stored in `user_investment_strategy` and fetched via `getUserStrategy(userId)`.

| Touch point | How strategy affects it |
|---|---|
| `POST /api/prediction/[ticker]` | Uses `strategy.investment_timeframe` to compute per-user horizon GPS |
| `GET /api/prediction/deepmoney` | Resolves timeframe to set `outlook` and `mlGate`; cache bucket is per-outlook |
| `GET /api/dashboard/recommendations` | Reads timeframe to select predicted_price column; patches GPS; scales thresholds by aggressiveness |
| `GET /api/user/portfolio` + watchlist | Read timeframe to select predicted_price column; patch GPS breakdown |

---

## Model Path Selection

Every prediction path honors the same two env vars:

| `USE_LEGACY_PREDICTION_MODEL` | `CS_MODEL_VERSION` | Active path |
|---|---|---|
| `true` | (ignored) | `predict_weighted_analysis_baseline.py` — frozen pre-refactor monolith |
| `false` / unset | `v1` | v3-split orchestrator + sklearn CS v1 (no TF) |
| `false` / unset | `v5` (default) | v3-split orchestrator + Keras CS v5 |

---

## MODEL_VARIANT Fix Stack (v3 / v4 / v5)

The orchestrator applies post-hoc adjustments after raw model output. Selected by `MODEL_VARIANT` env var:

| Variant | Adjustments |
|---|---|
| `v3` | Bare model output |
| `v4` | 90d momentum drift + VIX×beta confidence multiplier + direction deadband + RSI-beta short-term gate |
| `v5` (default) | v4 base + Fix A (downtrend-trap ceiling for high-beta) + Fix B (beta-signed VIX modifier) + Fix C (structural-decline ceiling) + Fix D (extreme-momentum scaler) |

Telemetry: `_apply_variant_adjustments()` emits a `variant_adjustments` block on every result (variant, VIX, RSI, beta, 30d/90d returns, and per-fix outputs when they fire).

---

## Feature Engine (Python)

### Full Feature Set

The Python model processes **118 total feature columns** including:
- 13 insider trading signals (form-4-derived)
- Regime probabilities (11 columns from GMM/KMeans detector)
- OHLCV-derived returns (5d/10d/20d/30d/60d/90d/180d)
- Technical indicators (RSI, MACD, Bollinger Bands, OBV, Stochastic)
- Fundamental ratios (PE, PB, EV/EBITDA, revenue/earnings growth)
- Macro context (VIX, beta, sector correlation)

All feature vectors are run through `numpy.nan_to_num` before scaling, so international tickers with NaN macro inputs don't crash the pipeline.

### Regime Analysis

Per-request GMM/KMeans regime detection over a 10-dimensional market vector (VIX, VIX 20d avg, Treasury 10Y, HYG/LQD credit-spread proxy, sector ETF correlation). `select_regime_k()` picks K=3 or K=4 against minimum state population (≥15%) and temporal flip-rate (≤30%) constraints.

### High-Beta Penalty

When `beta > 0.8` and both 30d and 90d returns are negative (bearish cascade), the model applies additional dampening to long-horizon predictions. The exact thresholds and scale factors are defined in the Fix A/C rules in `predict_weighted_analysis.py`.

---

## Sanitize Layer — Output Clamping

After the orchestrator runs, `_sanitize_predictions()` in `scripts/predict_core.py` applies:

- **Vol-scaled per-horizon caps:** base caps (15%/30%/60%) × `max(1, min(2.5, realized_vol_60d / 0.30))`
- **Price floor:** 0.01 minimum on all predicted prices
- **Confidence demotion to 25:** Only when the clamp catches a real outlier — not when coherent 3m+6m extrapolation pushes against vol-scaled caps (which keeps model's own confidence and sets `at_model_ceiling_*` flags)
- **Trajectory smoothness gate:** Catches legitimate cyclical peak-and-reverse forecasts; drops confidence to 60 (Medium) rather than 25 when the shape is coherent
- **`confidence_reason_{h}` strings:** Plain-language explanation surfaced by the UI tooltip on Medium/Low confidence badges

---

## Trajectory Generation

The trajectory chart uses a smooth Catmull-Rom cubic Bezier spline with 10 waypoints: T5, T21, T42, T63, T84, T105, T126, T147, T168, T189.

Prediction card waypoints:
- 1-week card: trajectory[0] (T5)
- 1-month card: trajectory[1] (T21)
- 3-month card: `monthly_trajectory[3]` (T63)
- 6-month card: `monthly_trajectory[6]` (T126)

**Card accent colors:** 1-week (purple), 1-month (blue), 3-month (emerald), 6-month (green border)

---

## Confidence Scoring

Confidence scores are produced by the model and adjusted by the fix stack. The confidence scoring system uses a discrete bucket scheme based on the model's observed output distribution: `{35, 50, 65, 75}`.

- **75 (High)** — Strong directional signal, low uncertainty
- **65 (Medium-High)** — Reasonable confidence
- **50 (Medium)** — Mixed signals or trajectory smoothness gate fired
- **35 (Low)** — Weak signal or vol-gate floor not cleared

The `direction_signal_1w` field carries `'up'` / `'down'` / `null` (neutral deadband). A direction conviction gate at 0.55/0.45 (p_up threshold) gates whether a direction signal is emitted.

---

## Persistence Layer

### `savePredictionAsync` Payload

Forwarded to `POST /api/prediction/save`:

| Field | Description |
|---|---|
| `predicted_price_{1w,1m,3m,6m}` | Price target per horizon |
| `predicted_change_pct_{1w,1m,3m,6m}` | Percentage change per horizon |
| `confidence_score_{1w,1m,3m,6m}` | Confidence per horizon |
| `gps_score` | Neutral 1m baseline GPS |
| `gps_breakdown` | JSON breakdown of all 8 GPS components |
| `confidence_reason_{h}` | Plain-language confidence explanation |
| `at_model_ceiling_{h}` | Boolean — whether prediction hit the vol-scaled cap |

### Analytics Recording

`recordPrediction()` (fire-and-forget) writes one row per `(symbol, predicted_at, model_version)` to `prediction_records`. This row is later resolved by `resolve_predictions.py` which fetches actual closing prices and grades direction accuracy.

---

## Batch Update: `update_predictions.py`

The nightly batch script refreshes cached predictions for all portfolio and watchlist items without requiring user interaction:

1. Fetches all users and their strategies (`get_all_user_strategies()`)
2. For each user's portfolio + watchlist stocks, calls `POST /api/prediction/{ticker}` with `x-api-key` auth
3. All four horizon prices + all eight per-horizon stats are persisted per run
4. **ETF Holdings Scan phase:** For each user with ETF holdings, fetches top holdings and runs prediction + GPS scoring, writing results to `etf_stock_recommendations`

---

## Cache Architecture

| Cache | Key | TTL |
|---|---|---|
| `predictionCache` | `{ticker}_{outlook}` (v3-split: `{ticker}_{outlook}_v3split_{csModelVersion}`) | Time-based |
| `stockDataCache` | `{ticker}` | Time-based |
| Per-user-per-ticker cooldown | `{userId}:{ticker}` | 30 seconds |

The cache schema version (currently v23) is embedded in the key. Changing the CS model version automatically produces fresh predictions by changing the key.
