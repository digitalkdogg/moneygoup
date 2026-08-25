-- =============================================================================
-- Migration: 3-Month Horizon Final Deploy
-- File:      migrations/2026_horizon_3m_deploy.sql
-- Run at:    Final deploy once Phase 3 backtest passes and Phase 4 code ships.
--
-- Phases 2a + 2b were run on 2026-08-24 (already in prod):
--   - 3m columns added to prediction_records and user_stock_predictions
--   - 3_month added to investment_timeframe enum
--   - 0 users remapped from 1_year → 6_month (backup table created)
--
-- This file handles the remaining two steps:
--   Step 1 (2c): Drop 1_year from the enum. Hard gate — do NOT skip.
--   Step 2 (2d): Archive 1y prediction columns (rename, do not drop).
--
-- Rollback:
--   Step 1: Re-add 1_year to the enum; restore from
--           user_investment_strategy_1y_migration_backup if any rows existed.
--   Step 2: Rename archived_* columns back to *_1y (trivially reversible).
-- =============================================================================

-- =============================================================================
-- STEP 1 — Drop 1_year from investment_timeframe enum (Phase 2c)
-- =============================================================================

-- Safety check: abort if any user is still on 1_year.
-- If this returns > 0, stop and investigate before proceeding.
SELECT
  CASE COUNT(*)
    WHEN 0 THEN 'OK — zero users on 1_year, safe to continue'
    ELSE CONCAT('STOP — ', COUNT(*), ' user(s) still on 1_year. Remap before proceeding.')
  END AS preflight_check
FROM user_investment_strategy
WHERE investment_timeframe = '1_year';

ALTER TABLE user_investment_strategy
  MODIFY investment_timeframe
    enum('1_week','1_month','3_month','6_month')
    NOT NULL DEFAULT '1_month';


-- =============================================================================
-- STEP 2 — Archive 1y prediction columns (Phase 2d)
-- Rename, never drop. Retained for at least one quarter for audit/rollback.
-- Schedule a DROP COLUMN cleanup migration when no longer needed.
-- =============================================================================

ALTER TABLE prediction_records
  CHANGE `predicted_price_1y`      `archived_predicted_price_1y`      decimal(12,4) DEFAULT NULL,
  CHANGE `predicted_change_pct_1y` `archived_predicted_change_pct_1y` decimal(8,4)  DEFAULT NULL,
  CHANGE `confidence_score_1y`     `archived_confidence_score_1y`     decimal(5,2)  DEFAULT NULL,
  CHANGE `signal_confidence_1y`    `archived_signal_confidence_1y`    decimal(5,2)  DEFAULT NULL,
  CHANGE `precedent_confidence_1y` `archived_precedent_confidence_1y` decimal(5,2)  DEFAULT NULL,
  CHANGE `at_model_ceiling_1y`     `archived_at_model_ceiling_1y`     tinyint(1)    DEFAULT NULL,
  CHANGE `confidence_reason_1y`    `archived_confidence_reason_1y`    text,
  CHANGE `actual_price_1y`         `archived_actual_price_1y`         decimal(12,4) DEFAULT NULL,
  CHANGE `accuracy_pct_1y`         `archived_accuracy_pct_1y`         decimal(6,2)  DEFAULT NULL,
  CHANGE `direction_correct_1y`    `archived_direction_correct_1y`    tinyint(1)    DEFAULT NULL,
  CHANGE `resolved_1y`             `archived_resolved_1y`             tinyint(1)    NOT NULL DEFAULT '0';

ALTER TABLE user_stock_predictions
  CHANGE `predicted_price_1y`      `archived_predicted_price_1y`      decimal(12,4) DEFAULT NULL,
  CHANGE `predicted_change_pct_1y` `archived_predicted_change_pct_1y` decimal(8,4)  DEFAULT NULL,
  CHANGE `confidence_score_1y`     `archived_confidence_score_1y`     decimal(5,2)  DEFAULT NULL;


-- =============================================================================
-- Verify
-- =============================================================================

SELECT 'prediction_records 3m columns' AS check_name,
       COUNT(*) AS col_count
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'prediction_records'
  AND COLUMN_NAME LIKE '%3m%';

SELECT 'prediction_records archived 1y columns' AS check_name,
       COUNT(*) AS col_count
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'prediction_records'
  AND COLUMN_NAME LIKE 'archived_%1y%';

SELECT 'investment_timeframe enum' AS check_name,
       COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA  = DATABASE()
  AND TABLE_NAME    = 'user_investment_strategy'
  AND COLUMN_NAME   = 'investment_timeframe';
