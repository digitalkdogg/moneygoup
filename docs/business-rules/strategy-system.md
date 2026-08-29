---
purpose: How user investment strategy (aggressiveness × timeframe) personalizes every score, recommendation, and prediction the platform produces.
sources: src/utils/strategy.ts, src/app/api/dashboard/recommendations/route.ts, user_investment_strategy table
triggers: Read on every authenticated API request that produces personalized scores or recommendations
related: [scoring-thresholds.md](scoring-thresholds.md), [recommendation-buckets.md](recommendation-buckets.md), [business-rules/gps-score.md](gps-score.md)
last_updated: 2026-08-28
---

# Strategy System

## Overview

Every authenticated user has a **UserStrategy** — a pair of preferences stored in the `user_investment_strategy` database table. These preferences are loaded on each API request and used to adjust recommendation thresholds, GPS scores, and predicted-price references **at read time**. The underlying ML model output and stored GPS data are *never mutated*; the strategy system applies lightweight transformations on the fly.

The single source of truth for all strategy logic is `src/utils/strategy.ts`. This module exports:
- Type definitions (`Aggressiveness`, `InvestmentTimeframe`, `UserStrategy`, `StrategyConfig`)
- Lookup tables (`AGGRESSIVENESS_GATES`, `TIMEFRAME_CONFIG`)
- Validators (`isValidAggressiveness`, `isValidTimeframe`)
- `getUserStrategy(userId)` — async DB lookup with graceful fallback
- `resolveStrategy()` — combines the two axes into a single `StrategyConfig`

The **3 aggressiveness levels × 4 timeframes = 12 combined configurations** are computed on the fly; nothing is pre-materialized.

!!! note "August 2026 change"
    The 1-year investment timeframe was retired and replaced by **3-month**. Valid timeframes are now `['1_week', '1_month', '3_month', '6_month']`. All `_1y` prediction columns have been replaced with `_3m` equivalents.

---

## Data Model

```typescript
export type Aggressiveness = 'safe' | 'neutral' | 'aggressive';
export type InvestmentTimeframe = '1_week' | '1_month' | '3_month' | '6_month';

export interface UserStrategy {
  aggressiveness: Aggressiveness;
  investment_timeframe: InvestmentTimeframe;
}

export const DEFAULT_STRATEGY: UserStrategy = {
  aggressiveness: 'neutral',
  investment_timeframe: '1_month',
};
```

`getUserStrategy(userId)` returns `DEFAULT_STRATEGY` if no row exists or if stored values fail validation. All callers wrap with `.catch(() => DEFAULT_STRATEGY)` so a DB failure degrades gracefully.

---

## Dimension 1 — Aggressiveness Gates

Controls **how strict the filtering gates are**. A safe investor sees only high-confidence, lower-volatility picks. An aggressive investor accepts lower GPS floors and a wider beta range in exchange for more picks.

| Gate | safe | neutral | aggressive | Description |
|---|---|---|---|---|
| `confidenceFloor` | 65 | 50 | 35 | Minimum AI model confidence score (0–100) |
| `betaCutoff` | 1.5 | 2.0 | 3.5 | Maximum beta — filters stocks more volatile than this multiplier of the market |
| `gpsGate` | 75 | 65 | 55 | Minimum GPS score for a BUY recommendation |
| `predChangeGate` | 3.0% | 1.5% | 0.5% | Base minimum predicted price change (%) |
| `envFloorMultiplier` | 1.05 | 1.00 | 0.95 | Applied to env-driven GPS thresholds (BUY and DISCOVERY) |

**`envFloorMultiplier` example:** With `GPS_RECOMMENDATION_BUY_THRESHOLD = 65` and safe aggressiveness → effective threshold = 65 × 1.05 = **68.25**. The SELL threshold is NOT scaled — sells use `timeframe.sellThresholdShift` instead, so users are always warned about underperformers regardless of aggressiveness.

---

## Dimension 2 — Timeframe Config

Controls **which prediction horizon is used** and scales threshold gates accordingly.

| Timeframe | `predChangeMultiplier` | `sellThresholdShift` | `mlGate` | `shortLabel` | `predictedPriceColumn` |
|---|---|---|---|---|---|
| `1_week` | 0.5 | -2 | 0.5% | `1W` | `predicted_price_1w` |
| `1_month` | 1.0 | 0 | 1.5% | `1M` | `predicted_price_1m` |
| `3_month` | 1.25 | +2 | 3.0% | `3M` | `predicted_price_3m` |
| `6_month` | 1.5 | +3 | 5.0% | `6M` | `predicted_price_6m` |

**Column interpretation:**
- **`predChangeMultiplier`** — stacked on `gates.predChangeGate`. Final effective gate = `gates.predChangeGate × timeframe.predChangeMultiplier`. Example: safe + 6-month user needs 3.0% × 1.5 = **4.5%** minimum predicted change.
- **`sellThresholdShift`** — *added* to the env-driven GPS SELL threshold (not multiplied). Positive shift at 6M means long-horizon investors tolerate a lower GPS before SELL fires; negative at 1W fires sooner.
- **`mlGate`** — minimum predicted change % for a DeepMoney pick to be validated by the ML signal in `/api/prediction/deepmoney`. When called by `deepmoney_sync.py` (unauthenticated), the route falls back to `DEFAULT_STRATEGY` → `mlGate = 1.5` (1-month default).
- **`shortLabel`** — compact card label returned as `horizonLabel` by watchlist/portfolio/recommendations APIs so the frontend renders *"3M Pred"* dynamically.
- **`predictedPriceColumn`** — the SQL column in `user_stock_predictions` to read for the predicted price. Routes also derive the suffix `sfx` (`'1w' | '1m' | '3m' | '6m'`) to read `predicted_change_pct_{sfx}` and `confidence_score_{sfx}`.

---

## Where Strategy is Applied

| Touch point | How strategy affects it |
|---|---|
| `GET /api/dashboard/recommendations` | Reads timeframe to select predicted_price column; patches GPS breakdown for horizon; scales GPS thresholds by aggressiveness; shifts sell threshold by timeframe |
| `GET /api/user/portfolio` | Reads timeframe to select predicted_price column; patches GPS breakdown via `adjustGpsForHorizon` |
| `GET /api/user/watchlist` | Same as portfolio |
| `POST /api/prediction/[ticker]` | Uses `strategy.investment_timeframe` to pick horizon-matched change% + confidence when computing the per-user GPS returned in the response |
| `GET /api/prediction/deepmoney` | Resolves user's timeframe to set `outlook` (prediction horizon) and `mlGate` (minimum predicted change threshold). Cache bucket is per-outlook. |
| `scripts/update_predictions.py` | Fetches all user strategies upfront via `get_all_user_strategies()`. ETF threshold gates are scaled by `envFloorMultiplier` and `predChangeGate`. |

!!! note "Sync script uses DEFAULT_STRATEGY"
    When `deepmoney_sync.py` calls the DeepMoney API, it has no session cookie — only the `x-api-key` header — so the route falls back to `DEFAULT_STRATEGY` (neutral / 1_month), giving `mlGate = 1.5` and `outlook = '1_month'`. That is why the Python pipeline's hardcoded `pred_threshold = 1.5` matches the server-side default.

---

## resolveStrategy()

`resolveStrategy(userStrategy)` combines the two axes into a single `StrategyConfig` that every route uses:

```typescript
export interface StrategyConfig {
  aggressiveness:       Aggressiveness;
  investment_timeframe: InvestmentTimeframe;
  gates:                StrategyGates;   // from AGGRESSIVENESS_GATES[aggressiveness]
  timeframe:            TimeframeConfig; // from TIMEFRAME_CONFIG[investment_timeframe]
}
```

---

## GPS Horizon Patching

The baseline GPS persisted globally uses the 1-month predicted change as the `mlpUpside` component. When a downstream route serves a user whose timeframe is not 1-month, `adjustGpsForHorizon(breakdown, horizonDeltaPct, horizonConfidence)` in `src/utils/gps.ts` swaps only the two horizon-dependent components (`mlpUpside` and `mlpConfidence`) and recomputes the total. The other 6 components pass through unchanged.

Because `/api/prediction/save` now persists the per-horizon `predicted_change_pct_*` + `confidence_score_*` directly, downstream routes plug the model's own outputs into the GPS formula rather than deriving the delta from stale price columns.

---

## Profile API

Users set their strategy via `PUT /api/user/profile` with `{ aggressiveness, investment_timeframe }` in the body. Both fields are validated with `isValidAggressiveness()` / `isValidTimeframe()`. Invalid values are rejected with a 400. The row is upserted into `user_investment_strategy`.

---

## Database Table

```sql
CREATE TABLE user_investment_strategy (
  user_id INT PRIMARY KEY,
  aggressiveness ENUM('safe', 'neutral', 'aggressive') NOT NULL DEFAULT 'neutral',
  investment_timeframe ENUM('1_week', '1_month', '3_month', '6_month') NOT NULL DEFAULT '1_month',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

Rows are created lazily (on first profile save). Missing rows fall back to `DEFAULT_STRATEGY` — no migration needed for existing users.
