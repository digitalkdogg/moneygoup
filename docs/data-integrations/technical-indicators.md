---
purpose: What technical indicators the platform computes, how they feed the GPS Score, and how the composite signal score is derived.
sources: src/app/api/stock_data/[ticker]/data/route.ts (calculateTechnicalIndicators), src/utils/gps.ts (GPS component 5)
triggers: Called on every GET /api/stock_data/[ticker]/data request and whenever a prediction is run
related: [model-training.md](model-training.md), [../business-rules/gps-score.md](../business-rules/gps-score.md), [../system-flows/prediction-pipeline.md](../system-flows/prediction-pipeline.md)
last_updated: 2026-08-28
---

# Technical Indicators Guide

GrowMyStocks computes four technical indicators server-side from historical OHLCV price data fetched via `yahoo-finance2`. These indicators are computed in `/api/stock_data/[ticker]/data` by calling `calculateTechnicalIndicators(historicalData, news, peRatio, pbRatio, marketCap)` and feed directly into GPS Score Component 5 (Technical Signal, max 20 pts).

---

## Indicators Computed

### SMA20 — 20-Day Simple Moving Average

| Property | Value |
|---|---|
| Computation | Simple average of the last 20 daily close prices |
| Signal score | Price above SMA20: **+1**; price below: **-1** |

### SMA50 — 50-Day Simple Moving Average

| Property | Value |
|---|---|
| Computation | Simple average of the last 50 daily close prices |
| Signal score | Price above SMA50: **+1**; price below: **-1** |

### RSI14 — 14-Period Relative Strength Index

| Property | Value |
|---|---|
| Computation | 14-period RSI using Wilder's smoothing (exponential average of gains/losses) |
| Signal score | RSI < 30 (oversold): **+2** / RSI > 70 (overbought): **-2** / else: **0** |
| Interpretation | Low RSI = potential bounce candidate; high RSI = potential pullback risk |

### Momentum — 10-Day Price Change

| Property | Value |
|---|---|
| Computation | `(currentPrice - price10DaysAgo) / price10DaysAgo` |
| Signal score | Positive momentum: **+1**; negative momentum: **-1** |

---

## Total Technical Score

The four component scores are summed into a single raw technical score:

```
totalScore = SMA20_score + SMA50_score + RSI14_score + Momentum_score
```

**Range:** -4 to +4 (can theoretically reach -14 to +14 when all valuation signals are included, which is the full range used in the GPS formula)

**Signal interpretation:**
- `totalScore ≥ +4` → **BUY** signal
- `totalScore ≤ -4` → **SELL** signal
- Otherwise → **HOLD**

---

## GPS Component 5 — Technical Signal (20 pts)

The raw technical score is mapped linearly to the GPS component's 0–20 pt range:

```
GPS_technical = min(max((technicalScore + 14) / 28, 0), 1) × 20
```

Where the extended range -14 to +14 is used to accommodate additional valuation signals (PE ratio, PB ratio, market cap) that the indicator function can optionally include. Without these optional inputs, the score stays within -4 to +4, which maps to approximately 7–15 pts on the GPS scale.

The raw `totalScore` is returned at the top level of the `/api/stock_data/[ticker]/data` payload as `technicalScore`, where the Python model reads it directly via `stock_data.get('technicalScore')`.

---

## Data Sources

All technical indicators are computed from historical OHLCV data retrieved via `yahooFinance.chart()`:

- **Historical data:** Daily OHLCV prices
- **Minimum history required:** 50+ trading days (SMA50 requires 50 data points)
- **API migration note:** Historical data migrated from deprecated `yahooFinance.historical()` to `yahooFinance.chart()` in May 2026

---

## Extended Indicator Set (Model Feature Engineering)

The ML model feature set includes a much broader set of derived indicators beyond the four used for GPS scoring. These are computed during prediction feature extraction and include:

**Price / momentum features (GREEN — safe for training):**
- Returns: 5d, 10d, 20d, 30d, 60d, 90d, 180d
- Volatility: historical volatility 30d, 60d
- ATR (Average True Range)
- Price relative to 52-week high/low
- Volume z-score (abnormal volume detection)

**Technical indicators (GREEN):**
- RSI (14-period)
- MACD and signal line
- Bollinger Band %B and width
- OBV (On-Balance Volume)
- Stochastic oscillator

**Fundamental features (RED — live data only):**
- PE ratio, PB ratio, PS ratio, EV/EBITDA
- Revenue growth YoY, earnings growth YoY
- Profit margin, free cash flow yield
- Analyst upside (consensus target vs. current price)

**Macro features (YELLOW — live-only, low-signal):**
- VIX level and 20-day average
- Beta (52-week vs. S&P 500)
- Sector and industry classification

See [model-training.md](model-training.md) for the full 118-column feature set used during model inference.

---

## Display: TechnicalIndicatorsDisplay Component

The computed indicators are rendered on `/search/[ticker]` via `TechnicalIndicatorsDisplay`. Each indicator shows:
- Current value
- Signal direction (bullish/bearish/neutral)
- Contribution to overall technical score

The `StockSignalPanel` component renders the composite GPS signal and the bearish downside warning when `breakdown.mlpUpside < 0`.
