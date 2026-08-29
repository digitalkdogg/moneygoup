---
purpose: Defines domain-specific terms used across all GrowMyStocks documentation so any reader can decode shorthand without prior context.
sources: gps_score.html, deepmoney_sync_workflow.html, prediction_workflow.html, model_training.html, business_rules.html
triggers: N/A — static reference
related: [index.md](index.md), [business-rules/gps-score.md](business-rules/gps-score.md), [data-integrations/model-training.md](data-integrations/model-training.md)
last_updated: 2026-08-28
---

# Glossary

---

## GPS Score

**GrowMyStocks Prediction Score.** A composite 0–100 metric that expresses how attractive a stock looks right now. Version 3.0 combines 8 components: ML Predicted Change 1m (20 pts), AI Model Confidence (5 pts), Revenue Growth YoY (12 pts), Earnings Growth YoY (12 pts), Technical Signal (20 pts), Analyst Price Target Upside (12 pts), Analyst Consensus Rating (9 pts), and 52-Week Momentum (10 pts).

Labels by range:

| Range | Label |
|---|---|
| 80–100 | Strong Buy |
| 65–79 | Buy |
| 45–64 | Hold |
| 30–44 | Sell |
| 0–29 | Strong Sell |

The score is recalculated every time a prediction runs. The baseline always reflects the 1-month horizon; per-user horizon patching is applied at read time via `adjustGpsForHorizon`. See [gps-score.md](business-rules/gps-score.md).

---

## DeepMoney

The AI-driven stock discovery system. In UI contexts "DeepMoney" refers to:

1. The **nightly discovery pipeline** (`scripts/deepmoney_sync.py`) that crawls ~28 news/data sources, extracts tickers, validates them with the ML model, and writes the results to `recommended_stocks`.
2. The **DeepMoney Picks widget** on the dashboard — a carousel of AI-curated stocks above the `GPS_DEEPMONEY_MIN_SCORE` threshold.

---

## DeepMoney Sync

The nightly background job (`scripts/deepmoney_sync.py`) that runs the full discovery cycle: macro context fetch → stock discovery from 28+ feeds → LightGBM ranker filter → MLP confidence gate → write to `recommended_stocks` and `hot_etfs`. Results power the Discovery bucket, DeepMoney Picks widget, and Off-Market Mover cards. Authenticates to the Next.js API via `x-api-key: DEEPMONEY_INTERNAL_SECRET`.

---

## Cross-Sectional Model (CS)

A machine learning model trained **once on all stocks simultaneously**, rather than per-ticker. The CS model is the primary prediction path today — it loads from `models/long_term_cs_v5.pkl` at Python process start and produces 3-month and 6-month price predictions. The per-ticker MLP is the fallback. CS enables transfer learning so tickers with sparse history still get informed predictions.

Current default: `CS_MODEL_VERSION=v5` — 87 features, Keras MLP with Huber loss, trained 2026-08-18, targets `forward_return_63d` / `forward_return_126d`. Model version tag: `v3split_v5`.

---

## Conviction Gate

The MLP confidence threshold that a stock must clear before being written to `recommended_stocks` during the DeepMoney sync. The gate has two levels:

- `mlpConfidenceFloor` — baseline minimum confidence (e.g., 60 at `DEEPMONEY_ALGORITHM=5`)
- `volGateFloor` — higher minimum for stocks with `beta > 2.5` (e.g., 65 at level 5)

Both thresholds are resolved from the `DEEPMONEY_ALGORITHM` preset via `models/algorithm_presets.json`. Renamed from "vol-gate" in early docs.

---

## Direction Signal

The model's predicted up/down direction for a given horizon. Expressed as `'up'` / `'down'` / `'neutral'`. A prediction is marked `neutral` when the absolute predicted change is within the **deadband** (|Δ| < 2%). Neutral predictions are excluded from direction-accuracy metrics. **Direction accuracy** (did the model correctly predict up vs. down?) is the headline quality metric for the platform, shown in the `ModelAccuracyWidget` on the dashboard.

---

## Prediction Horizon (1w / 1m / 3m / 6m)

The forward time window a prediction targets. The pipeline produces all four horizons in a single Python call:

| Horizon | Trading Days | Model |
|---|---|---|
| 1w | T+5 | Short-term MLP |
| 1m | T+21 | Short-term MLP (interpolated) |
| 3m | T+63 | CS long-term model |
| 6m | T+126 | CS long-term model |

The 1-year horizon was **retired** in August 2026 and replaced by 3-month. Per-horizon outputs are stored in `user_stock_predictions` as `predicted_price_{1w,1m,3m,6m}`, `predicted_change_pct_{1w,1m,3m,6m}`, and `confidence_score_{1w,1m,3m,6m}`.

---

## Ranking Training Snapshots

The table `ranking_training_snapshots` stores historical snapshots of features and forward returns used to train the cross-sectional ranker and CS models. Each row captures a point-in-time feature matrix for a ticker alongside its eventual forward return, so the model can learn cross-sectional patterns (e.g., which relative fundamental ratios predicted outperformance). The training pipeline in `scripts/build_ranking_dataset.py` populates this table.

---

## Bellwether ETF

A market regime proxy ETF (historically SPY, QQQ, or similar broad-market funds) whose price behavior was used to detect bull/bear market regimes during the DeepMoney sync. The v3 bellwether model was shipped 2026-07-09 to fix ETF ceiling saturation. As of 2026-08-25, the bellwether pass (`run_bellwether_pass()`) has been removed from the sync script and the `src/app/api/prediction/bellwether/` route directory is empty. If the bellwether feature is reintroduced, restore from git.

---

## Fix A / B / C / D

Post-hoc adjustment rules applied by the `v5` (default) `MODEL_VARIANT` fix stack in `scripts/predict_weighted_analysis.py`:

| Fix | Condition | Effect |
|---|---|---|
| Fix A | High-beta (β>0.8) in downtrend: 30d < −5% AND 90d < −10% | Downtrend-trap ceiling on 3m/6m predictions |
| Fix B | Beta-signed VIX modifier on `long_term_multiplier` | Low-beta (β<0.5) gets flight-to-quality boost; high-beta gets VIX dampener |
| Fix C | >20% below 52w high AND 90d < −15% (structural decline) | Additional ceiling on 3m/6m predictions |
| Fix D | Extreme momentum: `ret90d > 30%` | Move-delta scaler (up to 1.5×) to amplify confirmed momentum |

These run before confidence scoring. The `v4` variant is the base without Fix B. `v3` is bare model output.

---

## Vol Gate

See **Conviction Gate**. The term "vol gate" refers specifically to the beta-adjusted confidence gate in the DeepMoney sync that applies a stricter `volGateFloor` (instead of `mlpConfidenceFloor`) for high-beta stocks (`beta > 2.5`). When the sync log shows `[vol-gate] SKIP`, the stock's confidence score fell below the floor for its beta bracket.

!!! note "Two distinct skip causes"
    A CS score of 25 can happen for two unrelated reasons: (1) the model genuinely assigned low confidence (legitimate), or (2) the prediction data was not available (data starvation). Check the `reason=` field in the sync log to distinguish them.

---

## Sector Median

A fallback imputation value used when a stock's Yahoo Finance data is missing a fundamental (e.g., `revenueGrowth`). The pipeline computes the median of available values for the same GICS sector and substitutes it for missing rows, preventing `NaN` from propagating through the model. Computed in feature engineering before model inference.

---

## model_version tag

The string written to `prediction_records.model_version` to identify which prediction code path produced a row. Values:

| Tag | Path |
|---|---|
| `legacy` | `predict_weighted_analysis_baseline.py` (pre-refactor monolith) |
| `v3split_v5` | Current default — v3-split orchestrator with CS v5 |
| `v3split_v1` | v3-split orchestrator with CS v1 (sklearn, no TF) |

The unique index on `prediction_records` includes `model_version` so legacy and v3-split predictions can coexist for side-by-side comparison.

---

## green_v4_rebuild

An internal label for the major refactor that split `predict_weighted_analysis.py` into a three-file orchestrator (`predict_core.py` + `predict_short_term.py` + `predict_long_term.py`) and introduced the cross-sectional long-term model. The pre-refactor monolith is preserved at `scripts/predict_weighted_analysis_baseline.py` and activated by `USE_LEGACY_PREDICTION_MODEL=true`.

---

## Resolver

`scripts/resolve_predictions.py` — the script that retrospectively grades previously recorded predictions by fetching actual closing prices at each horizon's target date and writing the result back to `prediction_records`. It computes `direction_correct` (True/False/NULL for neutral deadband) for each horizon, `proximity_accuracy` (how close the price prediction was), and overall accuracy. These resolved rows feed `GET /api/analytics/model-accuracy` and the `ModelAccuracyWidget` on the dashboard.
