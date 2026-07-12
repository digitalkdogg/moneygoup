# Bluehost Deployment Plan — v5 Model + Prediction Details

Target: get local changes onto the Bluehost server so live predictions use the
v5 fix stack and the analytics recorder stops erroring out on the missing
schema columns.

## 1. Pre-flight (~ 5 min)

On the Bluehost box, before touching anything:

```bash
cd /path/to/moneygoup                 # replace with actual deploy root
git status                            # confirm clean
mysqldump -u kevin -p moneygoup prediction_records prediction_details \
  > /root/prediction_backup_$(date +%F).sql   # rollback safety net
ls -1 scripts/migrations/             # confirm nothing already applied by name
```

## 2. Database migrations (order matters — apply top-down)

Two migrations to apply. Both are additive (no data loss) and idempotent
(`IF NOT EXISTS` / all columns nullable).

### 2a. Create `prediction_details` table

File: `scripts/migrations/2026_07_10_create_prediction_details.sql`

```bash
mysql -u kevin -p moneygoup < scripts/migrations/2026_07_10_create_prediction_details.sql
```

```sql
CREATE TABLE IF NOT EXISTS `prediction_details` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `prediction_record_id` BIGINT UNSIGNED NOT NULL,

  -- Category 1: stock characteristics
  `market_cap` DECIMAL(22,2) DEFAULT NULL,
  `market_cap_bucket` VARCHAR(10) DEFAULT NULL,
  `industry` VARCHAR(128) DEFAULT NULL,
  `beta_snapshot` DECIMAL(8,4) DEFAULT NULL,
  `avg_daily_volume_30d` DECIMAL(20,2) DEFAULT NULL,
  `dividend_yield` DECIMAL(10,6) DEFAULT NULL,

  -- Category 2: market regime at prediction time
  `vix_at_prediction` DECIMAL(8,4) DEFAULT NULL,
  `spy_return_30d` DECIMAL(10,6) DEFAULT NULL,
  `yield_curve_spread` DECIMAL(8,4) DEFAULT NULL,
  `sector_etf_return_30d` DECIMAL(10,6) DEFAULT NULL,

  -- Category 3: stock's own state at prediction time
  `stock_return_30d` DECIMAL(10,6) DEFAULT NULL,
  `stock_return_90d` DECIMAL(10,6) DEFAULT NULL,
  `realized_vol_30d` DECIMAL(10,6) DEFAULT NULL,
  `pct_from_52w_high` DECIMAL(10,6) DEFAULT NULL,
  `rsi_14d` DECIMAL(8,4) DEFAULT NULL,

  -- Category 4: fundamentals snapshot proxy
  `pe_ratio` DECIMAL(12,4) DEFAULT NULL,
  `sector_median_pe` DECIMAL(12,4) DEFAULT NULL,
  `revenue_growth` DECIMAL(10,6) DEFAULT NULL,
  `profit_margin` DECIMAL(10,6) DEFAULT NULL,

  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_prediction_record` (`prediction_record_id`),
  KEY `idx_industry` (`industry`),
  KEY `idx_market_cap_bucket` (`market_cap_bucket`),
  CONSTRAINT `fk_prediction_details_record`
    FOREIGN KEY (`prediction_record_id`)
    REFERENCES `prediction_records` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 2b. Add 11 missing columns to `prediction_records`

File: `scripts/migrations/2026_07_11_add_missing_prediction_records_columns.sql`

```bash
mysql -u kevin -p moneygoup < scripts/migrations/2026_07_11_add_missing_prediction_records_columns.sql
```

```sql
ALTER TABLE `prediction_records`
  ADD COLUMN `accuracy_metrics`     JSON         DEFAULT NULL AFTER `gps_breakdown`,
  ADD COLUMN `data_quality`         JSON         DEFAULT NULL AFTER `accuracy_metrics`,
  ADD COLUMN `model_status`         VARCHAR(64)  DEFAULT NULL AFTER `data_quality`,
  ADD COLUMN `at_model_ceiling_6m`  TINYINT(1)   DEFAULT NULL AFTER `model_status`,
  ADD COLUMN `at_model_ceiling_1y`  TINYINT(1)   DEFAULT NULL AFTER `at_model_ceiling_6m`,
  ADD COLUMN `ceiling_direction`    VARCHAR(4)   DEFAULT NULL AFTER `at_model_ceiling_1y`,
  ADD COLUMN `confidence_breakdown` JSON         DEFAULT NULL AFTER `ceiling_direction`,
  ADD COLUMN `confidence_reason_1w` TEXT         DEFAULT NULL AFTER `confidence_breakdown`,
  ADD COLUMN `confidence_reason_1m` TEXT         DEFAULT NULL AFTER `confidence_reason_1w`,
  ADD COLUMN `confidence_reason_6m` TEXT         DEFAULT NULL AFTER `confidence_reason_1m`,
  ADD COLUMN `confidence_reason_1y` TEXT         DEFAULT NULL AFTER `confidence_reason_6m`;
```

**Verify** after each migration:

```bash
mysql -u kevin -p moneygoup -e "DESCRIBE prediction_details;"
mysql -u kevin -p moneygoup -e "DESCRIBE prediction_records;" | grep -E 'accuracy_metrics|confidence_reason'
```

## 3. Files to sync from local to Bluehost

Only files touched in this session that affect production. Everything else stays as-is.

| Local path | Purpose |
|------------|---------|
| `scripts/predict_weighted_analysis.py` | v4/v5 adjustments + `MODEL_VARIANT` gate |
| `scripts/predict_core.py` | `CACHE_SCHEMA_VERSION` 19 → 21 |
| `scripts/resolve_predictions.py` | Direction deadband (compute_accuracy_metrics) |
| `scripts/backtest_predictions.py` | Direction deadband + `prediction_details` write |
| `scripts/report_backtest.py` | **NEW** — multi-ticker + `-o` output + `--from-date/--to-date` |
| `scripts/migrations/2026_07_10_create_prediction_details.sql` | Migration file (already applied above) |
| `scripts/migrations/2026_07_11_add_missing_prediction_records_columns.sql` | Migration file (already applied above) |

**No changes** to `predict_short_term.py`, `predict_long_term.py`, `prediction_recorder.py`, `update_predictions.py`, or any TypeScript/React files.

### 3a. Sync via rsync (recommended)

```bash
# Run from local box, pointed at Bluehost SSH endpoint
rsync -avz --checksum \
  scripts/predict_weighted_analysis.py \
  scripts/predict_core.py \
  scripts/resolve_predictions.py \
  scripts/backtest_predictions.py \
  scripts/report_backtest.py \
  user@bluehost:/path/to/moneygoup/scripts/

rsync -avz \
  scripts/migrations/2026_07_10_create_prediction_details.sql \
  scripts/migrations/2026_07_11_add_missing_prediction_records_columns.sql \
  user@bluehost:/path/to/moneygoup/scripts/migrations/
```

### 3b. Or via git (if the Bluehost box tracks the repo)

Commit locally, push to a shared remote, `git pull` on Bluehost. Cleaner for
audit but requires the branch to be reviewed first.

## 4. Environment variables

Add to `.env.production` on Bluehost (or wherever the Python scripts read env
from):

```bash
# New — v5 fix stack toggle. Omit to default to v5. Set to 'v4' or 'v3'
# to reproduce older behavior for A/B testing.
MODEL_VARIANT=v5

# Existing — no change, just confirm these are still set:
DB_HOST=localhost
DB_USER=kevin
DB_PASSWORD=...
DB_DATABASE=moneygoup
DB_PORT=3306
```

`MODEL_VERSION_TAG` is only used by the backtest script (not live predictions),
so it doesn't need to be set globally — pass it inline when running a backtest.

## 5. Clear the prediction cache

`CACHE_SCHEMA_VERSION` was bumped 19 → 21, which invalidates every cached
prediction on disk. The cache is keyed by version, so stale entries are ignored
automatically — but they'll never be evicted, so you'll want to sweep the
directory to reclaim space:

```bash
# Optional — old cache is ignored, but this reclaims disk
find scripts/prediction_cache -type f -mtime +1 -delete
```

## 6. Verify live prediction path

```bash
# 6a. Analytics recorder no longer errors:
python3 scripts/update_predictions.py 2>&1 | grep -E 'Prediction recorded|ERROR'
#   Expected: many "[analytics] Prediction recorded for X" lines, zero ERRORs.

# 6b. New v5 telemetry present in output:
python3 scripts/predict_weighted_analysis.py AAPL --input_file /tmp/aapl.json 2>&1 \
  | jq '.variant_adjustments'
#   Expected: {"variant":"v5", "vix":..., ..., possibly fixA/C/D telemetry if triggered}

# 6c. prediction_details being populated:
mysql -u kevin -p moneygoup -e "SELECT COUNT(*) FROM prediction_details WHERE created_at > NOW() - INTERVAL 1 HOUR;"
#   Expected: > 0 after live predictions have run
```

## 7. Cron changes (if any)

**No new cron jobs needed.** Existing nightly cron for `resolve_predictions.py`
continues to work — the deadband logic is internal and doesn't need any command-
line change.

If you want to backfill details for existing prediction_records rows, that's a
separate one-off script — not part of this deploy.

## 8. Rollback plan

If v5 misbehaves in production, revert in this order (cheapest first):

1. **Env-var flip** — set `MODEL_VARIANT=v3` in `.env.production` and restart
   the Next.js/API server. All new predictions revert to bare model output;
   no code redeploy needed. **This is the fastest rollback (~30 seconds).**
2. **Code revert** — `git checkout <prev-sha> -- scripts/predict_*.py` on
   Bluehost, restart server. Reverts to the pre-v4/v5 code entirely.
3. **Schema revert** — the two migrations are additive, so the columns can
   stay in place with NULLs. No need to drop them unless disk is tight.

Backup restore (worst case):
```bash
mysql -u kevin -p moneygoup < /root/prediction_backup_YYYY-MM-DD.sql
```

## 9. Deploy checklist (copy-paste)

- [ ] `mysqldump` backup taken
- [ ] `2026_07_10_create_prediction_details.sql` applied, verified with DESCRIBE
- [ ] `2026_07_11_add_missing_prediction_records_columns.sql` applied, verified
- [ ] 5 Python scripts synced to `scripts/`
- [ ] `MODEL_VARIANT=v5` added to `.env.production`
- [ ] Old cache swept (optional)
- [ ] `update_predictions.py` smoke-tested — zero `[analytics] ERROR` lines
- [ ] One live prediction inspected — `variant_adjustments` telemetry present
- [ ] `prediction_details` row count grew after a live run
