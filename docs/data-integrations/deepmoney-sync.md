---
purpose: How the nightly DeepMoney batch process discovers, validates, and persists AI-curated stock recommendations.
sources: scripts/deepmoney_sync.py, src/app/api/prediction/deepmoney/route.ts, src/utils/algorithmPreset.ts, models/algorithm_presets.json
triggers: Cron job — nightly. Also triggered manually via GET /api/prediction/deepmoney?refresh=true
related: [model-training.md](model-training.md), [../business-rules/recommendation-buckets.md](../business-rules/recommendation-buckets.md), [../system-flows/prediction-pipeline.md](../system-flows/prediction-pipeline.md)
last_updated: 2026-08-28
---

# DeepMoney Sync Workflow (v2.8)

The DeepMoney sync is a background batch process (run as a cron job) that discovers, validates, and persists AI-curated stock recommendations and ETF picks to the database. The results power the dashboard's "AI Picks" panel, the Discovery recommendations feed, and the macro context snapshot visible to all approved users.

!!! note "Scope"
    This script writes only to `recommended_stocks` (both `hot_stocks` and `etf_holding` rows), `macro_context_snapshots`, `stocks`, `stock_gps_scores`, `user_stock_predictions`, and `user_stocks`. Analytics inserts also touch `prediction_records`. It does **not** write to `etf_stock_recommendations` — that table is populated by `scripts/update_predictions.py`.

---

## Step 0 — Entrypoint and Environment Loading

- **File:** `scripts/deepmoney_sync.py` — `if __name__ == "__main__": sync_deepmoney()`
- No CLI arguments — all configuration is environment-driven.
- Environment loading order (first file with a key wins): `.env.production` → `.env.local` → `.env`
- **Required env vars:** `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `DEEPMONEY_INTERNAL_SECRET`
- **Key optional knobs:** `DEEPMONEY_ALGORITHM` (float 1.0–10.0, default 5)

All calls use `INTERNAL_API_URL = 'http://localhost:3001'` (hardcoded). This bypasses nginx and its 60-second proxy timeout — the discovery route can take over 2 minutes.

!!! warning "Port change warning"
    If the Next.js server port ever changes from 3001, `INTERNAL_API_URL` must be updated manually in each Python script — it is not controlled by an environment variable.

---

## Step 1 — Macro Data Sync

**Component:** `scripts/get_macro_data.py` + `/api/worldbank`

Fetches consolidated World Bank macroeconomic indicators:
- **Indicators:** GDP Growth, Inflation, FDI, Trade Volume, Tech Adoption, Unemployment
- **Countries:** USA, GBR, CHN, IND, DEU
- **Persistence:** When `wb_data.success` is true, issues an `INSERT ... ON DUPLICATE KEY UPDATE` against `macro_context_snapshots` using today's date as the key
- **Failure mode:** Returns `None` on any network error; the stock sync still runs

---

## Step 2 — DeepMoney Discovery Trigger

**Endpoint called:** `GET /api/prediction/deepmoney?refresh=true`

**Authorization:** Uses `DEEPMONEY_INTERNAL_SECRET` via the `x-api-key` header.

**Discovery sources (Stage 1) — 28 primary feeds:**

| # | Source | Format | Category |
|---|---|---|---|
| 1–3 | Yahoo Finance — DJI, GSPC, IXIC headlines RSS | RSS | Index news |
| 4–7 | Yahoo screener (small cap gainers, most actives, undervalued growth, aggressive small caps) | JSON | Screener |
| 8–16 | MarketBeat, TheStreet, Motley Fool, CNBC, MarketWatch, Seeking Alpha, Investing.com, CNBC device, TipRanks | RSS | Equity news |
| 17 | SEC EDGAR — 8-K atom (count=40) | Atom | Regulatory |
| 18, 26 | SEC EDGAR — Form 4 atom | Atom (Form 4) | Insider activity |
| 19 | ApeWisdom — filter/all-stocks (5-mention minimum) | JSON | Social sentiment |
| 20–22 | Silicon Alley Insider, FierceBiotech, FierceElectronics | RSS | Sector news |
| 23–28 | SpaceNews, OilPrice.com, DIA RSS, Defense News land/space | RSS/JSON | Sector news |
| A | Popular ETFs — top holdings of ~20 ETFs via internal `/holdings` | JSON | Index/sector exposure |
| B | Yahoo Finance earnings calendar (HTML scrape) | HTML | Earnings season |
| C | Internal trending feed — `GET /api/market/trending?window=48h&limit=50` | JSON | 48h trending |

Every URL is fetched concurrently via `Promise.allSettled` with a 15-second timeout. Per-feed failures are non-fatal.

**Secondary expansion:** After the primary pass, the first 30 primary tickers are each used to fetch a Yahoo per-ticker feed, and any additional tickers mentioned in those feeds are added to the candidate pool. This typically doubles the discovered ticker count.

---

## Step 3 — Python-side Gates

Every candidate has already survived the server-side LightGBM ranker (or the analyst-override lane). The Python sync applies one additional gate:

```
Candidate stock (already a ranker survivor)
↓
Analytics fire-and-forget: record_prediction() — written BEFORE the vol-gate
↓
Gate: MLP Confidence Floor (algorithm preset)
  conf_score ≥ mlpConfidenceFloor (or ≥ volGateFloor if beta > 2.5)
↓
Written to recommended_stocks
↓
ATH Warning Flag check:
  hi_ratio > 0.97 AND beta > 2.0 → append ⚠️ATH to metric_label
```

### Volatility-Adjusted Confidence Gate

```python
conf_score = pred_input.get('confidence_score') or pred_input.get('confidence_score_1m') or 0
beta_val = s.get('beta') or 1.0

confidence_floor = vol_gate_floor if beta_val > 2.5 else mlp_confidence_floor
if conf_score < confidence_floor:
    print(f"  [vol-gate] SKIP {ticker}: CS {conf_score} < floor {confidence_floor}")
    continue
```

| Beta range | Minimum confidence score |
|---|---|
| beta ≤ 2.5 | `mlpConfidenceFloor` (from preset) |
| beta > 2.5 | `volGateFloor` (from preset, always ≥ `mlpConfidenceFloor`) |

**Preset values at key algorithm levels:**

| Level | `mlpConfidenceFloor` | `volGateFloor` |
|---|---|---|
| 1 (strictest) | 75 | 75 |
| 5 (default) | 60 | 65 |
| 10 (loosest) | 30 | 35 |

---

## Step 4 — Dashboard Qualification

After per-stock validation, the full candidate set is evaluated for dashboard inclusion. `GPS_DEEPMONEY_MIN_SCORE` (default 65) is the read-side filter for the DeepMoney Picks widget — distinct from the write-side GPS gate which was removed in v2.7 (the ranker is now the sole write-side filter).

---

## Step 5 — ETF Holdings

**Component:** `src/utils/etfDiscovery.ts`, `src/utils/etfHoldings.ts`

ETF qualification uses a separate preset knob: `ETF_HOLDING_ALGORITHM` (float 1.0–10.0, default 5). It resolves into five fields via `models/etf_holding_presets.json`:

| Field | L5 default | Description |
|---|---|---|
| `etfGpsThreshold` | 58 | Minimum ETF GPS to qualify as "hot" |
| `topNEtfs` | 11 | How many qualifying ETFs survive |
| `maxTickers` | 56 | Per-ETF holdings fetch + scoring cap |
| `gpsSurfaceValue` | 60 | Minimum holding GPS to surface |
| `minPredChangePct` | 1.8% | Minimum predicted-change % for a holding to surface |

---

## Step 5.5 — Dashboard Tenure Reconciliation

After ETF holdings are written, the sync reconciles which recommendations are still relevant for each user based on how long they've been in their portfolio. This prevents stale ETF holding recommendations from persisting after a user sells an ETF.

---

## Step 6 — Persistence and Cleanup

### Off-Market Movers

`sync_off_market_movers()` scans the full processed ticker universe for pre-market and after-hours price moves:
- **Source:** `recommended_stocks WHERE type='off_market_mover'`
- **Threshold:** Absolute move ≥ 3% (`OFF_MARKET_MIN_CHANGE_PCT = 3.0`)
- **Detection window:** Rolling 2-day window
- **Market states:** PRE, POST, POSTPOST (normalized to POST)
- **Positive movers only** — negative moves excluded

### Analytics Recording

`record_prediction()` (from `scripts/prediction_recorder.py`) fires for every ranker survivor — including those rejected by the vol-gate — so the team can measure how often the floor was right to reject.

### End-of-Run Summary Block

The run prints a funnel summary: stocks rejected by enrichment → by signal score → by insufficient history (<100 trading days) → passed to analyzer → rejected by LightGBM ranker → analyst-consensus surfaced → final filtered count.

---

## Tables Written

| Table | Notes |
|---|---|
| `recommended_stocks` | Hot stocks and ETF holding rows |
| `macro_context_snapshots` | Daily macro context |
| `stocks` | Master stock record (upserted on new discovery) |
| `stock_gps_scores` | GPS score per stock |
| `user_stock_predictions` | Per-user predictions (ETF pipeline only) |
| `prediction_records` | Analytics ledger — all ranker survivors |

---

## Algorithm Preset Reference

`DEEPMONEY_ALGORITHM` (float 1.0–10.0) resolves via `models/algorithm_presets.json`:

| Field | Level 1 | Level 5 (default) | Level 10 |
|---|---|---|---|
| `rankerKeepPct` | ~7% | 25% | 60% |
| `mlpConfidenceFloor` | 75 | 60 | 30 |
| `volGateFloor` | 75 | 65 | 35 |
| `analystStrongBuyThreshold` | High | Medium | Low |
| `signalScoreFloor` | High | Medium | Low |

Fractional values (e.g., 1.5) interpolate linearly; `mlpConfidenceFloor` and `volGateFloor` snap UP to the next discrete MLP bucket in `{35, 50, 65, 75}`.

```
DEEPMONEY_ALGORITHM=1.5   # very strict: top ~7% by ranker, effective CS ≥ 75
DEEPMONEY_ALGORITHM=5     # default: top 25%, effective CS ≥ 65
DEEPMONEY_ALGORITHM=8     # loose: top 60%, effective CS ≥ 50
```

---

## Scheduling

Run the sync as a nightly cron job. Example:

```
0 2 * * * cd /var/www/html/moneygoup && python3 scripts/deepmoney_sync.py >> /var/log/deepmoney.log 2>&1
```

The script is a single-file executable with no CLI arguments. Monitor the log for `[vol-gate] SKIP` lines to tune aggressiveness, and `[ERROR]` lines for feed failures.
