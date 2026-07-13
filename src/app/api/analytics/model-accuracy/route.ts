import { NextRequest, NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/analytics/model-accuracy');

// Simple in-memory cache with TTL (1 hour)
const CACHE_TTL_MS = 60 * 60 * 1000;
const MIN_SAMPLE_SIZE = 30;

interface CacheEntry {
  data: any;
  expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol'); // Optional: per-symbol accuracy
  const skipCache = searchParams.get('skip_cache') === 'true';

  const cacheKey = `accuracy_${symbol || 'global'}`;
  const cachedEntry = cache.get(cacheKey);

  if (!skipCache && cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return NextResponse.json(cachedEntry.data);
  }

  // Clear cache to force fresh calculation
  cache.clear();

  try {
    const pool = await getDbConnection();
    const conn = await pool.getConnection();

    try {
      let response: any;

      if (symbol) {
        // Per-symbol accuracy
        response = await getPerSymbolAccuracy(conn, symbol);
      } else {
        // Global accuracy
        response = await getGlobalAccuracy(conn);
      }

      // Cache the response
      cache.set(cacheKey, {
        data: response,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return NextResponse.json(response);
    } finally {
      conn.release();
    }
  } catch (error) {
    logger.error('Failed to fetch accuracy metrics', { error });
    return NextResponse.json(
      { error: 'Failed to fetch accuracy metrics' },
      { status: 500 }
    );
  }
}

async function getGlobalAccuracy(conn: any) {
  // Calculate MAPE-based accuracy for each timeframe
  const query = `
    SELECT
      COUNT(*) AS total_records,

      -- 1 Week
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0) AS resolved_count_1w,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_1w - actual_price_1w) / NULLIF(actual_price_1w, 0))), 2)
       FROM prediction_records
       WHERE predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0) AS avg_accuracy_pct_1w,
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0
       AND GREATEST(0, 1 - ABS(predicted_price_1w - actual_price_1w) / NULLIF(actual_price_1w, 0)) >= 0.95) AS count_95_1w,

      -- 1 Month
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0) AS resolved_count_1m,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_1m - actual_price_1m) / NULLIF(actual_price_1m, 0))), 2)
       FROM prediction_records
       WHERE predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0) AS avg_accuracy_pct_1m,
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0
       AND GREATEST(0, 1 - ABS(predicted_price_1m - actual_price_1m) / NULLIF(actual_price_1m, 0)) >= 0.95) AS count_95_1m,

      -- 6 Month
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0) AS resolved_count_6m,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_6m - actual_price_6m) / NULLIF(actual_price_6m, 0))), 2)
       FROM prediction_records
       WHERE predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0) AS avg_accuracy_pct_6m,
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0
       AND GREATEST(0, 1 - ABS(predicted_price_6m - actual_price_6m) / NULLIF(actual_price_6m, 0)) >= 0.95) AS count_95_6m,

      -- 1 Year
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0) AS resolved_count_1y,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_1y - actual_price_1y) / NULLIF(actual_price_1y, 0))), 2)
       FROM prediction_records
       WHERE predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0) AS avg_accuracy_pct_1y,
      (SELECT COUNT(*) FROM prediction_records
       WHERE predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0
       AND GREATEST(0, 1 - ABS(predicted_price_1y - actual_price_1y) / NULLIF(actual_price_1y, 0)) >= 0.95) AS count_95_1y,

      MAX(updated_at) AS last_resolved_at

    FROM prediction_records
  `;

  const [rows] = await conn.execute(query);
  const row = rows[0];

  const totalResolved = (row.resolved_count_1w || 0) + (row.resolved_count_1m || 0) +
                        (row.resolved_count_6m || 0) + (row.resolved_count_1y || 0);

  if (totalResolved < MIN_SAMPLE_SIZE) {
    return {
      status: 'insufficient_data',
      message: `Accuracy tracking is live — check back when we have ${MIN_SAMPLE_SIZE}+ resolved predictions across any single horizon`,
      total_records: row.total_records || 0,
      last_resolved_at: row.last_resolved_at,
    };
  }

  // Calculate total accuracy using MAPE formula: max(0, 1 - |Predicted - Actual| / Actual)
  // Across all predictions and all timeframes
  const totalAccuracyQuery = `
    SELECT
      ROUND(
        100 * AVG(accuracy_score),
        2
      ) AS total_accuracy_pct
    FROM (
      SELECT GREATEST(0, 1 - ABS(predicted_price_1w - actual_price_1w) / NULLIF(actual_price_1w, 0)) AS accuracy_score
      FROM prediction_records
      WHERE predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0
      UNION ALL
      SELECT GREATEST(0, 1 - ABS(predicted_price_1m - actual_price_1m) / NULLIF(actual_price_1m, 0)) AS accuracy_score
      FROM prediction_records
      WHERE predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0
      UNION ALL
      SELECT GREATEST(0, 1 - ABS(predicted_price_6m - actual_price_6m) / NULLIF(actual_price_6m, 0)) AS accuracy_score
      FROM prediction_records
      WHERE predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0
      UNION ALL
      SELECT GREATEST(0, 1 - ABS(predicted_price_1y - actual_price_1y) / NULLIF(actual_price_1y, 0)) AS accuracy_score
      FROM prediction_records
      WHERE predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0
    ) AS all_accuracies
  `;

  const [totalAccuracyRows] = await conn.execute(totalAccuracyQuery);
  const totalAccuracyValue = totalAccuracyRows[0]?.total_accuracy_pct;
  const totalAccuracy = totalAccuracyValue !== null && totalAccuracyValue !== undefined ? Number(totalAccuracyValue) : null;

  const formatAccuracy = (val: any) => val !== null && val !== undefined ? Number(val) : null;
  const formatInt = (val: any) => val !== null && val !== undefined ? Number(val) : 0;

  return {
    status: 'ready',
    total_records: row.total_records || 0,
    total_accuracy_pct: totalAccuracy,
    last_resolved_at: row.last_resolved_at,

    horizons: {
      '1_week': {
        resolved_count: formatInt(row.resolved_count_1w),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_1w),
        high_accuracy_count: formatInt(row.count_95_1w),
      },
      '1_month': {
        resolved_count: formatInt(row.resolved_count_1m),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_1m),
        high_accuracy_count: formatInt(row.count_95_1m),
      },
      '6_month': {
        resolved_count: formatInt(row.resolved_count_6m),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_6m),
        high_accuracy_count: formatInt(row.count_95_6m),
      },
      '1_year': {
        resolved_count: formatInt(row.resolved_count_1y),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_1y),
        high_accuracy_count: formatInt(row.count_95_1y),
      },
    },
  };
}

async function getPerSymbolAccuracy(conn: any, symbol: string) {
  // Calculate MAPE-based accuracy for each timeframe for a specific symbol
  const query = `
    SELECT
      symbol,
      -- 1 Week
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0) AS resolved_1w,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_1w - actual_price_1w) / NULLIF(actual_price_1w, 0))), 2)
       FROM prediction_records
       WHERE symbol = ? AND predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0) AS avg_accuracy_pct_1w,
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0
       AND GREATEST(0, 1 - ABS(predicted_price_1w - actual_price_1w) / NULLIF(actual_price_1w, 0)) >= 0.95) AS count_95_1w,

      -- 1 Month
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0) AS resolved_1m,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_1m - actual_price_1m) / NULLIF(actual_price_1m, 0))), 2)
       FROM prediction_records
       WHERE symbol = ? AND predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0) AS avg_accuracy_pct_1m,
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0
       AND GREATEST(0, 1 - ABS(predicted_price_1m - actual_price_1m) / NULLIF(actual_price_1m, 0)) >= 0.95) AS count_95_1m,
      -- direction accuracy 1m — SUM/COUNT of direction_correct_1m (excludes NULL/neutral)
      (SELECT SUM(direction_correct_1m) FROM prediction_records
       WHERE symbol = ? AND direction_correct_1m IS NOT NULL) AS dir_correct_1m,
      (SELECT COUNT(direction_correct_1m) FROM prediction_records
       WHERE symbol = ? AND direction_correct_1m IS NOT NULL) AS dir_resolved_1m,

      -- 6 Month
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0) AS resolved_6m,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_6m - actual_price_6m) / NULLIF(actual_price_6m, 0))), 2)
       FROM prediction_records
       WHERE symbol = ? AND predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0) AS avg_accuracy_pct_6m,
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0
       AND GREATEST(0, 1 - ABS(predicted_price_6m - actual_price_6m) / NULLIF(actual_price_6m, 0)) >= 0.95) AS count_95_6m,

      -- 1 Year
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0) AS resolved_1y,
      (SELECT ROUND(100 * AVG(GREATEST(0, 1 - ABS(predicted_price_1y - actual_price_1y) / NULLIF(actual_price_1y, 0))), 2)
       FROM prediction_records
       WHERE symbol = ? AND predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0) AS avg_accuracy_pct_1y,
      (SELECT COUNT(*) FROM prediction_records
       WHERE symbol = ? AND predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0
       AND GREATEST(0, 1 - ABS(predicted_price_1y - actual_price_1y) / NULLIF(actual_price_1y, 0)) >= 0.95) AS count_95_1y
    FROM prediction_records
    WHERE symbol = ?
    GROUP BY symbol
  `;

  const [rows] = await conn.execute(query, [symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol, symbol]);

  if (rows.length === 0) {
    return {
      status: 'no_data',
      symbol,
      message: 'No prediction records found for this symbol',
    };
  }

  const row = rows[0];
  const totalResolved = (row.resolved_1w || 0) + (row.resolved_1m || 0) +
                        (row.resolved_6m || 0) + (row.resolved_1y || 0);

  if (totalResolved < MIN_SAMPLE_SIZE) {
    return {
      status: 'insufficient_data',
      symbol,
      message: 'Not enough resolved predictions yet for this symbol',
      total_resolved: totalResolved,
    };
  }

  // Calculate total accuracy for this symbol using MAPE formula across all timeframes
  const totalAccuracyQuery = `
    SELECT
      ROUND(
        100 * AVG(accuracy_score),
        2
      ) AS total_accuracy_pct
    FROM (
      SELECT GREATEST(0, 1 - ABS(predicted_price_1w - actual_price_1w) / NULLIF(actual_price_1w, 0)) AS accuracy_score
      FROM prediction_records
      WHERE symbol = ? AND predicted_price_1w IS NOT NULL AND actual_price_1w IS NOT NULL AND actual_price_1w > 0
      UNION ALL
      SELECT GREATEST(0, 1 - ABS(predicted_price_1m - actual_price_1m) / NULLIF(actual_price_1m, 0)) AS accuracy_score
      FROM prediction_records
      WHERE symbol = ? AND predicted_price_1m IS NOT NULL AND actual_price_1m IS NOT NULL AND actual_price_1m > 0
      UNION ALL
      SELECT GREATEST(0, 1 - ABS(predicted_price_6m - actual_price_6m) / NULLIF(actual_price_6m, 0)) AS accuracy_score
      FROM prediction_records
      WHERE symbol = ? AND predicted_price_6m IS NOT NULL AND actual_price_6m IS NOT NULL AND actual_price_6m > 0
      UNION ALL
      SELECT GREATEST(0, 1 - ABS(predicted_price_1y - actual_price_1y) / NULLIF(actual_price_1y, 0)) AS accuracy_score
      FROM prediction_records
      WHERE symbol = ? AND predicted_price_1y IS NOT NULL AND actual_price_1y IS NOT NULL AND actual_price_1y > 0
    ) AS all_accuracies
  `;

  const [totalAccuracyRows] = await conn.execute(totalAccuracyQuery, [symbol, symbol, symbol, symbol]);
  const totalAccuracyValue = totalAccuracyRows[0]?.total_accuracy_pct;
  const totalAccuracy = totalAccuracyValue !== null && totalAccuracyValue !== undefined ? Number(totalAccuracyValue) : null;

  const formatAccuracy = (val: any) => val !== null && val !== undefined ? Number(val) : null;
  const formatInt = (val: any) => val !== null && val !== undefined ? Number(val) : 0;

  return {
    status: 'ready',
    symbol,
    total_accuracy_pct: totalAccuracy,
    horizons: {
      '1_week': {
        resolved_count: formatInt(row.resolved_1w),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_1w),
        high_accuracy_count: formatInt(row.count_95_1w),
      },
      '1_month': {
        resolved_count: formatInt(row.resolved_1m),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_1m),
        high_accuracy_count: formatInt(row.count_95_1m),
        // Direction accuracy — count of correct calls / count of non-neutral calls.
        // `dir_resolved` excludes rows where direction_correct is NULL (neutral).
        direction_correct_count: formatInt(row.dir_correct_1m),
        direction_resolved_count: formatInt(row.dir_resolved_1m),
        direction_accuracy_pct: row.dir_resolved_1m && Number(row.dir_resolved_1m) > 0
          ? Math.round(100 * Number(row.dir_correct_1m) / Number(row.dir_resolved_1m))
          : null,
      },
      '6_month': {
        resolved_count: formatInt(row.resolved_6m),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_6m),
        high_accuracy_count: formatInt(row.count_95_6m),
      },
      '1_year': {
        resolved_count: formatInt(row.resolved_1y),
        proximity_accuracy_pct: formatAccuracy(row.avg_accuracy_pct_1y),
        high_accuracy_count: formatInt(row.count_95_1y),
      },
    },
  };
}
