---
purpose: How the ML prediction models are trained, what data they use, and how to retrain or version them.
sources: model_training.html, scripts/predict_weighted_analysis.py, scripts/predict_short_term.py, scripts/predict_long_term.py, scripts/train_long_term_cs_v2.py, scripts/build_ranking_dataset.py
triggers: Model training is a manual offline process; inference runs on each prediction request
related: [technical-indicators.md](technical-indicators.md), [../system-flows/prediction-pipeline.md](../system-flows/prediction-pipeline.md), [deepmoney-sync.md](deepmoney-sync.md)
last_updated: 2026-08-28
---

# Model Training Reference

GrowMyStocks runs two parallel prediction paths for every ticker. The **per-ticker MLP path** fits a fresh model on each stock's own history — flexible but slow. The **cross-sectional (CS) path** trains one model across the entire universe, enabling transfer learning where tickers with sparse history still get informed predictions.

!!! note "Current active path"
    The CS model is the primary path today (`CS_MODEL_VERSION=v5`). The per-ticker MLP is the fallback when the CS artifact is missing or fails to load. A third model — the **LightGBM ranker** — scores relative attractiveness across the universe and powers the Discovery feed.

---

## Prediction Horizons

The pipeline is split into two horizon groups, each with its own model file and feature mask:

| Horizon | Trading Days | Model File | Architecture | Feature Mask | Label Source |
|---|---|---|---|---|---|
| **1w** | T+5 | `predict_short_term.py` | MLP 96/48/24 | SHORT_TERM (momentum, technical, microstructure) | Per-ticker sequence |
| **1m** | T+21 | `predict_short_term.py` | MLP 96/48/24 | SHORT_TERM | Interpolated 1w → 3m waypoint |
| **3m** | T+63 | `predict_long_term.py` | MLP 192/96/48 | LONG_TERM (macro, fundamental, long-horizon momentum) | `forward_return_63d` label |
| **6m** | T+126 | `predict_long_term.py` | MLP 192/96/48 | LONG_TERM | `forward_return_126d` label |

!!! note "1-year horizon retired"
    The 1-year horizon was retired in August 2026 and replaced by 3-month. The `_1y` DB columns still exist but are no longer written.

---

## Model Paths

### Cross-Sectional (CS) — Primary Path

- Trained once on all stocks simultaneously
- Stored in `models/long_term_cs_v5.pkl` (current default)
- Loaded once at Python process start
- ~292 survivor tickers + 120 sector leaders in training set
- Direction accuracy is the headline quality metric

### Per-Ticker MLP — Fallback Path

- Fit on each stock's own historical sequence
- No stored artifact — trained live per prediction request
- 45-day lookback window (`SEQ_LEN = 45`)
- 50 epochs (`N_EPOCHS = 50`), seed 42
- Used when CS model artifact is absent or corrupt

---

## CS Model Version History

| CS Version | Backend | Loss | Features | Targets | TF Required | Trained |
|---|---|---|---|---|---|---|
| `v1` | sklearn MLPRegressor | MSE | — | forward_return_126d, forward_return_252d | No | — |
| `v2` | Keras + TF | Huber(δ=0.5) + joint consistency penalty | — | forward_return_126d, forward_return_252d | Yes | — |
| `v5` (current) | Keras + TF | Huber loss | 87 features | forward_return_63d, forward_return_126d | Yes | 2026-08-18 |

**Model version tag:** `v3split_v5`

The CS model loads from `models/long_term_cs_{version}.pkl` at import time. The pkl holds a sklearn-compatible `.predict()` object (for v1) or a `KerasModelWrapper` instance (for v2/v5) that lazy-loads the underlying `.keras` file on first call.

---

## Model Path Selection (Environment Variables)

| `USE_LEGACY_PREDICTION_MODEL` | `CS_MODEL_VERSION` | Active path |
|---|---|---|
| `true` | (ignored) | `predict_weighted_analysis_baseline.py` — frozen pre-refactor monolith, single MLPRegressor |
| `false` / unset | `v1` | v3-split orchestrator + sklearn CS v1 (no TF dependency) |
| `false` / unset | `v5` (default) | v3-split orchestrator + Keras CS v5 (requires tensorflow-cpu) |

---

## Feature Engineering

Features are classified into three tiers:

**GREEN — safe for training (can be computed historically without lookahead):**

- **Price / OHLCV:** Returns 5d/10d/20d/30d/60d/90d/180d, realized volatility 30d/60d, ATR, price vs. 52w high/low, volume z-score
- **Technical indicators:** RSI-14, MACD + signal, Bollinger Band %B and width, OBV, Stochastic oscillator, SMA20, SMA50
- **Momentum:** Rolling beta, 10-day price change, 52-week change

**RED — live data only (cannot be reconstructed historically without lookahead):**

- PE ratio, PB ratio, PS ratio, EV/EBITDA
- Revenue growth YoY, earnings growth YoY, profit margin
- Free cash flow yield
- Analyst price target upside
- Insider buying/selling signals

**YELLOW — live-only but low-signal:**

- VIX level and 20-day average
- Macro indicators (FRED series values)

**Total feature columns: 118** (including 13 added in v3.3)

---

## Training Pipeline

### Building the Training Dataset

```bash
python3 scripts/build_ranking_dataset.py
```

This script:
1. Fetches historical OHLCV + fundamental data for the survivor universe
2. Computes per-snapshot feature vectors
3. Calculates forward returns at each horizon
4. Writes rows to `ranking_training_snapshots`

**Training universe:** ~292 survivor tickers + 120 sector leaders (412 total). Survivors are selected based on minimum data quality and trading history thresholds.

### Training the CS Model

```bash
python3 scripts/train_long_term_cs_v2.py
```

Loads from `ranking_training_snapshots`, trains the Keras MLP, and saves to `models/long_term_cs_v5.pkl`. Training targets are `forward_return_63d` (3-month) and `forward_return_126d` (6-month).

**Key hyperparameters (v5):**
- Architecture: 192/96/48 hidden layers
- Loss: Huber (δ=0.5)
- Features: 87 (LONG_TERM feature mask)

### Training the LightGBM Ranker

The ranker model ranks relative attractiveness across the universe (not absolute return prediction). It uses a learning-to-rank objective and outputs a percentile score. Trained on `ranking_training_snapshots` with forward return as the ranking label.

```bash
python3 scripts/train_ranker.py
```

Output: `models/ranker_model.lgb`

---

## Regime Detection

The model includes a per-request GMM/KMeans regime detector that runs over a 10-dimensional market vector:

| Input | Source |
|---|---|
| VIX level | Yahoo Finance ^VIX |
| VIX 20-day average | Derived from VIX history |
| Treasury 10Y | Yahoo Finance ^TNX |
| HYG/LQD spread proxy | Credit spread ETF prices |
| Sector ETF correlation | Rolling correlation |

`select_regime_k()` picks K=3 or K=4 (bull / neutral / bear, or bull / neutral / bear / distressed) against minimum state population (≥15%) and temporal flip-rate (≤30%) constraints. Regime probabilities are appended as 11 additional feature columns before scaling and feed all four MLP horizons.

---

## Inference Flow

### Cross-Sectional Path

1. Load `models/long_term_cs_v5.pkl` at process import time
2. Extract 87 LONG_TERM features from the stock data payload
3. Apply regime detector → append 11 regime probability columns
4. Scale features using the stored scaler (included in pkl)
5. Call `_CS_MODEL.predict(X)` → returns `[return_63d_pred, return_126d_pred]`
6. Convert returns to price targets for 3m and 6m horizons

### Per-Ticker MLP Path (fallback)

1. Extract 45-day rolling window of normalized OHLCV data
2. Train a fresh sklearn MLPRegressor (50 epochs, seed 42)
3. Predict T+5, T+21, T+63, T+126 targets
4. Apply post-hoc adjustment stack (MODEL_VARIANT v3/v4/v5)

---

## Post-Hoc Adjustment Stack (MODEL_VARIANT)

Selected by the `MODEL_VARIANT` environment variable:

| Variant | Adjustments |
|---|---|
| `v3` | Bare model output (no post-hoc adjustments) |
| `v4` | 90d momentum drift + VIX×beta confidence multiplier + direction deadband + RSI-beta short-term gate |
| `v5` (default) | v4 base + Fix A/B/C/D (see [Glossary](../glossary.md)) |

The **deadband** in v4/v5: `|Δ| < 2%` → `predicted_direction_{h} = 'neutral'`. Near-flat predictions yield `direction_correct = NULL` and are excluded from direction-accuracy metrics.

---

## Backtesting

```bash
# Specific tickers
python3 scripts/backtest/run_backtest.py AAPL MSFT --period "6 months" --step 7

# Random diverse batch (mix of sectors + large/mid/small cap)
python3 scripts/backtest/run_backtest.py --random 20 --period "6 months" --step 7

# Reproducible run with seed
python3 scripts/backtest/run_backtest.py --random 15 --seed 42 --period "1 year" --step 14
```

**Backtested horizons:** 1w, 1m, 3m, 6m

**Key accuracy metrics:**
- **Direction accuracy** — did the model correctly predict up vs. down? (headline metric; deadband: ±0.5% for 1w, ±2% for 1m, ±5% for 3m/6m)
- **Proximity accuracy** — `max(0, (1 - |actual - pred| / actual) * 100)%`
- **MAPE** — mean absolute percentage error

The backtest produces a self-contained HTML report in `reports/` with a 4-horizon summary and per-ticker drill-down detail table.

---

## Retrain Checklist

1. Regenerate training dataset: `python3 scripts/build_ranking_dataset.py`
2. Verify dataset size and quality (check `ranking_training_snapshots` row count)
3. Train the CS model: `python3 scripts/train/train_long_term_cs_v2.py`
4. Rename artifact: `mv models/long_term_cs_new.pkl models/long_term_cs_v6.pkl`
5. Update `CS_MODEL_VERSION=v6` in `.env.local`
6. Run backtest to verify no regression: `python3 scripts/backtest/run_backtest.py --random 20 --period "6 months" --step 7`
7. Deploy and monitor direction accuracy in `ModelAccuracyWidget`

!!! warning "Direction accuracy regression risk"
    The CS v2 naive retrain regressed direction accuracy from 72% to 53% due to universe drift (not bearish training window). Always validate direction accuracy on a held-out set before shipping a new model version. See the `cs_v2_retrain_findings` memory note for context.
