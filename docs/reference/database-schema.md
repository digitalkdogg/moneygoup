---
purpose: Complete reference for the MySQL database schema — table definitions, column types, indexes, and core business logic patterns.
sources: doc/moneygoup_schema.sql, src/app/api/*/route.ts
triggers: Read on every request; written by prediction pipeline, DeepMoney sync, and user-action routes
related: [../system-flows/prediction-pipeline.md](../system-flows/prediction-pipeline.md), [../data-integrations/deepmoney-sync.md](../data-integrations/deepmoney-sync.md), [api-routes.md](api-routes.md)
last_updated: 2026-08-28
---

# Database Schema Reference

MoneyGoUp uses a single MySQL database. Column lists are verified against the canonical schema dump at `doc/moneygoup_schema.sql`.

---

## Core Business Logic Patterns

### Portfolio vs. Watchlist vs. Discovery

The `user_stocks` table manages all stock relationships via two boolean columns:

| `is_purchased` | `user_confirmed` | `shares > 0` | `is_active` | State |
|---|---|---|---|---|
| 0 | 1 | — | 1 | **Watchlist** — user explicitly monitoring |
| 1 | 1 | > 0 | 1 | **Portfolio** — user owns a confirmed position |
| 0 | 0 | — | 1 | **Discovery** — AI-discovered, not yet user-confirmed |
| 1 | 1 | 0 | 0 | **Closed position** — shares sold; row retained for history |

### GPS Score Read Priority

1. `stock_gps_scores` — primary (one row per stock, always current)
2. `recommended_stocks` — fallback GPS (DeepMoney discovery rows)
3. No data — `GET /api/stock_data/[ticker]/gps` returns `{ source: "none" }`

GPS is written only when the score changes at 1-decimal precision, avoiding spurious DB writes on repeat predictions.

### Authentication and Governance

- New users are created with `approval_status = 'pending'`. Only `'approved'` users can establish a session.
- `checkApprovalGuard()` re-queries `approval_status` on every authenticated API request (AUTH-1 fix, May 2026).
- Quotas are enforced by the `role_limits` configuration table and the `LimitService` utility.

---

## Auth and User Tables

### users

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `username` | VARCHAR(255) | NOT NULL. Unique. |
| `email` | VARCHAR(255) | Nullable. Unique. Used for password reset. |
| `password_hash` | VARCHAR(255) | NOT NULL. bcrypt, cost factor 10. |
| `created_at` | TIMESTAMP | Default CURRENT_TIMESTAMP. |
| `modified_at` | TIMESTAMP | Default CURRENT_TIMESTAMP, ON UPDATE CURRENT_TIMESTAMP. |
| `role` | ENUM('user','superuser','admin') | NOT NULL. Default 'user'. |
| `approval_status` | ENUM('pending','approved','rejected','unsubscribed','archived') | NOT NULL. Default 'pending'. |
| `approved_by` | INT (FK → users.id) | Nullable. Admin who last changed approval status. ON DELETE SET NULL. |
| `approved_at` | DATETIME | Nullable. Approval timestamp. |
| `rejected_reason` | VARCHAR(255) | Nullable. Free-text reason from admin. |
| `last_login` | DATETIME | Nullable. Updated on each successful login. |

Indexes: `idx_users_approval_status`, `idx_users_role`.

### password_reset_tokens

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `user_id` | INT (FK → users.id) | NOT NULL. ON DELETE CASCADE. |
| `token_hash` | VARCHAR(255) | NOT NULL. SHA-256 hash of the raw 64-char hex token. Unique. |
| `expires_at` | DATETIME | NOT NULL. 1 hour from creation. |
| `used_at` | DATETIME | Nullable. NULL until consumed. |
| `created_at` | TIMESTAMP | Default CURRENT_TIMESTAMP. |

Existing unused tokens for a user are deleted before a new one is created — at most one active reset link per user.

### role_limits

Configuration table for quota enforcement.

| Column | Type | Notes |
|---|---|---|
| `role` | ENUM('user','superuser','admin') | Primary key |
| `max_watchlist_items` | INT | Nullable. NULL = unlimited. |
| `max_portfolio_items` | INT | Nullable. NULL = unlimited. |
| `max_lookups_per_24h` | INT | Nullable. NULL = unlimited. |
| `updated_at` | DATETIME | ON UPDATE CURRENT_TIMESTAMP. |

### user_investment_strategy

Per-user investment strategy preferences. Drives GPS gates, prediction-change cutoffs, and which horizon column is read from `user_stock_predictions`. Read via `getUserStrategy()`. Written via `PATCH /api/user/profile`. Falls back to `{ aggressiveness: 'neutral', investment_timeframe: '1_month' }` when no row exists.

| Column | Type | Notes |
|---|---|---|
| `user_id` | INT | Primary key. FK to users.id ON DELETE CASCADE. |
| `aggressiveness` | ENUM('safe','neutral','aggressive') | Default 'neutral'. |
| `investment_timeframe` | ENUM('1_week','1_month','3_month','6_month') | Default '1_month'. 1-year retired August 2026. |
| `updated_at` | TIMESTAMP | ON UPDATE CURRENT_TIMESTAMP. |

Written via `INSERT ... ON DUPLICATE KEY UPDATE` — partial updates preserve the other field.

---

## Stock Reference Tables

### stocks

Master list of all tracked tickers. Also serves as the search index for `/api/search`.

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `symbol` | VARCHAR(10) | NOT NULL. Unique. |
| `company_name` | VARCHAR(255) | NOT NULL. Sanitized by `normalizeYahooData()` — strips characters outside `[a-zA-Z0-9 &.,'-]` before write. |
| `price` | DECIMAL(10,2) | Nullable. Last cached price. |
| `pe_ratio` | DECIMAL(10,2) | Nullable. Trailing P/E cache. |
| `pb_ratio` | DECIMAL(10,2) | Nullable. Price-to-book ratio cache. |
| `market_cap` | BIGINT | Nullable. Raw dollars. |
| `sector` | VARCHAR(64) | Nullable. Yahoo `assetProfile.sector`. |
| `industry` | VARCHAR(128) | Nullable. Yahoo `assetProfile.industry`. |
| `size_bucket` | ENUM('mega','large','mid','small','micro','nano') | Nullable. Derived from `market_cap`. Thresholds: mega ≥ $200B, large ≥ $10B, mid ≥ $2B, small ≥ $300M, micro ≥ $50M, else nano. |
| `search_tsv` | TEXT | Nullable. Synonym blob feeding the FULLTEXT index — industry keyword expansions that make "Large Retail" hit WMT. Regenerated by `scripts/backfill_stock_search.py`. |
| `created_at` | TIMESTAMP | Default CURRENT_TIMESTAMP. |

**Indexes:**
- `ft_stocks_search` — FULLTEXT on `(symbol, company_name, sector, industry, search_tsv)`
- `idx_stocks_sector_size` — btree on `(sector, size_bucket)`
- `idx_stocks_industry` — btree on `industry`

### user_stocks

Relationship table linking users to their monitored and owned stocks.

| Column | Type | Notes |
|---|---|---|
| `user_id` | INT | PK part 1. FK to users.id ON DELETE CASCADE. |
| `stock_id` | INT | PK part 2. FK to stocks.id ON DELETE CASCADE. |
| `shares` | DECIMAL(10,4) | NOT NULL. Default 0.0000. |
| `purchase_price` | DECIMAL(10,2) | NOT NULL. Average price at time of add. |
| `is_purchased` | TINYINT(1) | NOT NULL. Default 0. 0 = Watchlist/Discovery, 1 = Portfolio. |
| `initial_purchase_date` | DATETIME | Nullable. Timestamp of first buy. |
| `last_transaction_date` | DATETIME | Nullable. Most recent buy or sell. |
| `is_active` | TINYINT(1) | NOT NULL. Default 1. 0 when shares = 0 after a sell (closed position). |
| `created_at` | TIMESTAMP | Default CURRENT_TIMESTAMP. |
| `user_confirmed` | TINYINT(1) | NOT NULL. Default 1. 1 = Manual add, 0 = AI Auto-discovery. |
| `average_cost_basis` | DECIMAL(14,4) | Nullable. Weighted average cost per share, updated on each transaction. |

### user_lookup_events

Audit trail for user stock lookups; used to enforce 24-hour rate limits.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT | Primary key. Auto-increment. |
| `user_id` | INT | FK to users.id ON DELETE CASCADE. |
| `ticker` | VARCHAR(20) | The symbol looked up. |
| `looked_up_at` | DATETIME | Default CURRENT_TIMESTAMP. |
| `source` | VARCHAR(50) | Nullable. API source (web, mobile). |

Index: `idx_lookup_user_time (user_id, looked_up_at)`.

### stocksdailyprice

End-of-day historical OHLCV snapshots for tracked stocks.

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `stock_id` | INT | FK to stocks.id ON DELETE CASCADE. |
| `date` | DATE | NOT NULL. |
| `open`, `high`, `low`, `close` | DECIMAL(10,2) | NOT NULL. |
| `volume` | INT | NOT NULL. |
| `adj_open`, `adj_high`, `adj_low`, `adj_close`, `adj_volume` | DECIMAL(10,2) / INT | Nullable. Adjusted series. `adj_close` used by the accuracy resolver. |
| `daily_change` | DECIMAL(10,2) | Nullable. Day-over-day delta cache. |

Unique key: `(stock_id, date)`.

---

## Recommendation Tables

### recommended_stocks

Stores the latest DeepMoney discovery results. Supports multiple record types via the `type` column.

**Record types:** `hot_stocks`, `hot_ai_tech_stocks`, `etf_holding`, `off_market_mover`

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `type` | VARCHAR(50) | NOT NULL. Indexed. |
| `ticker` | VARCHAR(10) | NOT NULL. Indexed. |
| `company_name` | VARCHAR(255) | NOT NULL. |
| `current_price` | DECIMAL(12,4) | Nullable. Price at discovery time. |
| `gps_score` | DECIMAL(8,2) | Nullable. 0–100. Always NULL for off_market_mover rows. |
| `gps_breakdown` | JSON | Nullable. Named component scores. NULL for off_market_mover rows. |
| `trading_signal` | VARCHAR(20) | Nullable. BUY / HOLD / SELL. |
| `trading_signal_score` | INT | Nullable. Raw signal score. |
| `analyst_upside_pct` | DECIMAL(8,2) | Nullable. Analyst consensus price target upside %. |
| `revenue_growth_yoy` | DECIMAL(10,2) | Nullable. Year-over-year revenue growth %. |
| `metric_value` | DECIMAL(12,4) | Nullable. Primary numeric metric. For `off_market_mover`: extended-hours change %. Requires `Number()` coercion before arithmetic. |
| `metric_label` | VARCHAR(100) | Nullable. For `off_market_mover`: `'Pre-Market'` or `'After-Hours'`. |
| `snapshot_date` | DATE | NOT NULL. Date of the discovery run. Indexed (composite with type). |
| `created_at` | TIMESTAMP | Default CURRENT_TIMESTAMP. |

The dashboard recommendations route reads `off_market_mover` rows with a 2-day rolling window (`snapshot_date >= CURDATE()-1`) and filters to `metric_value > 0`.

### recommended_markets

Market-level context records written by DeepMoney sync. Types: `hot_markets` (hot market sectors) and `hot_ai_sectors` (hot AI sub-sector analysis).

### hot_etfs

ETF-level records with GPS scores used to power the "Hot ETFs" discovery section.

### etf_stock_recommendations

Individual stock recommendations derived from ETF holdings analysis. Written by `scripts/update_predictions.py` during the ETF Holdings scan phase. Read by the dashboard recommendations route using `snapshot_date = (SELECT MAX(snapshot_date) FROM etf_stock_recommendations WHERE user_id = ?)`.

---

## Prediction Tables

### user_stock_predictions

Persists multi-horizon AI-generated price predictions keyed by user and stock. Each row stores the full set of horizon-specific predicted prices, change percentages, and confidence scores so the dashboard can recompute horizon-aware GPS without re-running the model.

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `user_id` | INT | FK to users.id ON DELETE CASCADE. Part of unique key. |
| `stock_id` | INT | FK to stocks.id ON DELETE CASCADE. Part of unique key. |
| `predicted_price_1w` | DECIMAL(12,4) | Nullable. AI 1-week price target. |
| `predicted_price_1m` | DECIMAL(12,4) | NOT NULL. AI 1-month price target (legacy default). |
| `predicted_price_3m` | DECIMAL(12,4) | Nullable. Replaces retired `predicted_price_1y` (August 2026). |
| `predicted_price_6m` | DECIMAL(12,4) | Nullable. AI 6-month price target. |
| `predicted_change_pct_1w` | DECIMAL(8,4) | Nullable. Direct model output: predicted % change at 1-week horizon. |
| `predicted_change_pct_1m` | DECIMAL(8,4) | Nullable. 1-month predicted % change. |
| `predicted_change_pct_3m` | DECIMAL(8,4) | Nullable. 3-month predicted % change. |
| `predicted_change_pct_6m` | DECIMAL(8,4) | Nullable. 6-month predicted % change. |
| `confidence_score_1w` | DECIMAL(5,2) | Nullable. MLP confidence 0–100 for 1-week. |
| `confidence_score_1m` | DECIMAL(5,2) | Nullable. 1-month confidence. |
| `confidence_score_3m` | DECIMAL(5,2) | Nullable. 3-month confidence. |
| `confidence_score_6m` | DECIMAL(5,2) | Nullable. 6-month confidence. |
| `last_requested_at` | DATETIME | NOT NULL. Timestamp of last prediction run. |
| `macro_features_used` | JSON | Nullable. Snapshot of macro feature inputs. |
| `consumer_multiplier_applied` | DECIMAL(5,4) | Nullable. Macro-driven multiplier for consumer-sector predictions. |

Unique key: `uniq_user_stock_prediction (user_id, stock_id)`.

!!! note "GPS columns removed"
    `gps_score` and `gps_breakdown` were dropped from this table (May 2026). GPS now lives once per stock in `stock_gps_scores` and is read via a `LEFT JOIN`.

### stock_gps_scores

Canonical GPS score table — one row per stock, always reflecting the latest computed score.

| Column | Type | Notes |
|---|---|---|
| `stock_id` | INT | Primary key. FK to stocks.id ON DELETE CASCADE. |
| `as_of` | DATETIME | NOT NULL. Timestamp of the prediction run. |
| `gps_score` | DECIMAL(5,1) | NOT NULL. 0–100. |
| `gps_breakdown` | JSON | Nullable. Component scores: mlpUpside, mlpConfidence, revenueGrowth, earningsGrowth, technicalSignal, analystUpside, analystConsensus, priceChange52w. |
| `model_version` | VARCHAR(40) | Nullable. Optional model identifier. |
| `regime` | VARCHAR(50) | Nullable. Optional GMM market regime label. |
| `source` | VARCHAR(40) | NOT NULL. Default 'prediction_engine'. One of: `prediction_engine`, `deepmoney_sync`, `user_backfill`, `recommended_backfill`. |
| `created_at`, `updated_at` | DATETIME | NOT NULL. `updated_at` does not change if GPS score is unchanged. |

Write optimisation: all writers perform a `SELECT gps_score` before each write. If the incoming score matches the stored value at 1-decimal precision, the upsert, history insert, and `recommended_stocks` sync are all skipped.

### stock_gps_score_history

Append-only audit log of GPS score changes. A new row is inserted only when `gps_score` changes from its previous value.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT | Primary key. Auto-increment. |
| `stock_id` | INT | FK to stocks.id ON DELETE CASCADE. |
| `as_of` | DATETIME | NOT NULL. Part of unique key with `model_version`. |
| `gps_score` | DECIMAL(5,1) | NOT NULL. Score at this point in time. |
| `gps_breakdown` | JSON | Nullable. Component scores snapshot. |
| `model_version` | VARCHAR(40) | Nullable. MySQL treats NULL as distinct in UNIQUE keys. |
| `source` | VARCHAR(40) | NOT NULL. Default 'prediction_engine'. |
| `created_at` | DATETIME | NOT NULL. Default CURRENT_TIMESTAMP. |

Unique key: `uniq_stock_asof_model (stock_id, as_of, model_version)`.

### prediction_records

Analytics and prefetch ledger of multi-horizon model predictions. Two roles:
1. Source of headline accuracy KPIs for `ModelAccuracyWidget`
2. Source of the prefetched prediction on `/search/[ticker]` when the freshest row is < 12 hours old

Written fire-and-forget by `recordPrediction()` in `src/utils/predictionRecorder.ts` (browser flow) and `record_prediction()` in `scripts/prediction_recorder.py` (batch). Actuals are populated by `scripts/resolve_predictions.py` after each horizon elapses.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT UNSIGNED | Primary key. Auto-increment. |
| `symbol` | VARCHAR(20) | Ticker. |
| `predicted_at` | DATETIME | Second-level precision — multiple regenerates in one day produce distinct rows. |
| `model_version` | VARCHAR(20) | e.g. `legacy` or `v3split_v5`. Read side filters by current model version. |
| `price_at_prediction` | DECIMAL(12,4) | Spot price at prediction time. Baseline for MAPE. |
| `predicted_price_1w/_1m/_3m/_6m` | DECIMAL(12,4) | Nullable. `_1y` column still exists in DB but is no longer written. |
| `predicted_change_pct_1w/_1m/_3m/_6m` | DECIMAL(8,4) | Percentage change vs `price_at_prediction`. |
| `confidence_score_1w/_1m/_3m/_6m` | DECIMAL(5,2) | Per-horizon model confidence 0–100. |
| `gps_score` | DECIMAL(5,1) | 1m-baseline GPS score at prediction time. |
| `gps_breakdown` | JSON | 1m-baseline GPS breakdown (8 components). |
| `accuracy_metrics` | JSON | `{model: {mae, rmse, cv_mae}}` — model performance metrics. |
| `data_quality` | JSON | `historyDays`, `historyYears`, `fundamentalsComplete`, `analystDataAvailable`, `imputedFields`, `missingFeatureMetrics`. |
| `model_status` | VARCHAR(64) | e.g. `fallback_baseline_model` when primary path failed. |
| `at_model_ceiling_3m/_6m` | TINYINT(1) | Set by `_sanitize_predictions` when prediction coherently pushes against the vol-scaled cap. |
| `ceiling_direction` | VARCHAR(4) | `'up'` or `'down'`. |
| `confidence_breakdown` | JSON | `{total, components: {cv_mape, history, features, analyst}}`. |
| `confidence_reason_1w/_1m/_3m/_6m` | TEXT | Plain-language explanation when `_sanitize_predictions` manually adjusts confidence. |
| `actual_price_1w/_1m/_3m/_6m` | DECIMAL(12,4) | Nullable. Spot price N days after `predicted_at`. Filled by resolver. |
| `accuracy_pct_1w/_1m/_3m/_6m` | DECIMAL(6,2) | Proximity accuracy 0–100. Filled by resolver. |
| `direction_correct_1w/_1m/_3m/_6m` | TINYINT(1) | 1 if predicted direction matched actual. Headline metric. |
| `resolved_1w/_1m/_3m/_6m` | TINYINT(1) | 0 → not yet resolved. Set to 1 by resolver after actuals are computed. |
| `created_at` | DATETIME | Row-insert timestamp. Used by `latest-prediction` for the 12-hour freshness filter. |
| `updated_at` | DATETIME | Auto-updated on any modification. `MAX(updated_at)` surfaces as `last_resolved_at` in the analytics endpoint. |

**Write pattern:** Plain `INSERT` (no `INSERT IGNORE` or `ON DUPLICATE KEY UPDATE`) — every fresh prediction gets a new row. The browser flow gates its write on `outlook=='all' && !isInternal` to avoid duplicate writes when the batch also calls the same route.

Indexes: `idx_symbol`, `idx_predicted_at`, `idx_symbol_model (symbol, model_version)`, `idx_created_at`, four `idx_resolved_*`.

---

## Rotation and AI Take Tables

### dashboard_tenure

Tracks how many consecutive days each recommendation has appeared on the dashboard for each user. Used by the tenure rotation algorithm to surface fresh cards and avoid showing the same picks indefinitely.

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `user_id` | INT | FK to users.id ON DELETE CASCADE. |
| `ticker` | VARCHAR(20) | Stock symbol. |
| `first_seen_date` | DATE | Date the ticker first appeared in this user's recommendation pool. |
| `last_seen_date` | DATE | Date of the most recent sync that included this ticker. |
| `consecutive_days` | INT | Running count of consecutive days on the dashboard. |

### ai_ticker_takes

Caches AI-generated stock analysis paragraphs from the Ollama/Gemma pipeline.

| Column | Type | Notes |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `ticker` | VARCHAR(20) | Stock symbol. |
| `data_hash` | VARCHAR(64) | SHA-256 of `(model + gps_score + gps_breakdown + predicted_change_pct + analyst_upside + trading_signal)` — invalidation key. |
| `ai_take` | TEXT | The generated paragraph (~60-80 words). |
| `model_name` | VARCHAR(100) | Ollama model used (e.g. `gemma3:1b`). |
| `created_at` | DATETIME | Row creation time. |
| `updated_at` | DATETIME | ON UPDATE CURRENT_TIMESTAMP. |

---

## ML Training Tables

### ranking_training_snapshots

Training dataset for the Cross-Sectional (CS) model and LightGBM ranker. Populated by `scripts/build_ranking_dataset.py`.

Each row is a per-ticker snapshot at a point in time containing the full feature vector used during training. The `forward_return_63d` and `forward_return_126d` columns are the training targets for the CS model.

### fred_macro_indicators

Stores FRED (Federal Reserve Economic Data) series values used as macro features during prediction inference.

---

## Portfolio History Tables

### portfolio_transactions

Append-only ledger of buy and sell transactions for each portfolio position.

### portfolio_daily_snapshots

Daily portfolio value snapshots for the portfolio history chart.

### portfolio_position_history

Per-position value history for tracking individual stock performance over time.

### portfolio_benchmark_performance

Benchmarks portfolio returns against index performance (S&P 500, DJI).

---

## Analytics and Social Tables

### news / stock_news

Stores scraped news articles associated with stocks. Used as context for AI Take generation.

### user_stock_news

Per-user news feed items.

### stock_brand

Brand color and logo metadata fetched from the brand-logo service. Used to render the brand accent strip on portfolio cards.

---

## Macroeconomic Data Tables

### macro_context_snapshots

Daily World Bank macroeconomic snapshots written by the DeepMoney sync. Used for the macro context panel visible to all approved users.

### world_bank_macro_data

Annual macro series from the World Bank API used as features for GMM regime detection and global risk analysis.

| Column | Type | Notes |
|---|---|---|
| `indicator_code` | VARCHAR(50) | NOT NULL. e.g. NY.GDP.MKTP.KD.ZG (GDP Growth). |
| `country_code` | VARCHAR(3) | Default 'USA'. USA, GBR, CHN, IND, DEU. |
| `year` | INT | NOT NULL. |
| `value` | DECIMAL(15,5) | Nullable. |
| `last_updated` | TIMESTAMP | ON UPDATE CURRENT_TIMESTAMP. |

Unique key: `idx_wb_indicator_year (indicator_code, country_code, year)`.

### world_bank_etf_gps_factors

Thematic and sector-specific signals for ETF GPS scoring. Stores multiplier effects per World Bank indicator per theme.

---

## Ancillary Tables

### preview_leads / preview_visits

Marketing capture tables for the landing page preview/lead generation flow.
