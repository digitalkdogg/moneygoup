// src/app/api/prediction/save/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { isInternalRequest } from '@/utils/internalAuth';
import { unauthorizedResponse, createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';
import { select, upsert, executeRawQuery } from '@/utils/databaseHelper';
import { checkApprovalGuard } from '@/utils/approvalStatus';

const logger = createLogger('api/prediction/save');

// Validation schema for save payload
const savePredictionSchema = z.object({
  ticker: tickerSchema,
  predicted_price_1d: z.number().positive().optional(),
  predicted_price_1m: z.coerce.number().positive('predicted_price_1m must be a positive number'),
  predicted_price_6m: z.number().positive().optional(),
  predicted_price_1y: z.number().positive().optional(),
  gps_score: z.coerce.number().min(0).max(100).nullable().optional(),
  gps_breakdown: z.any().optional(),
  macro_features_used: z.array(z.string()).optional(),
  consumer_multiplier_applied: z.number().optional(),
  last_requested_at: z.string().datetime().optional(),
  user_id: z.string().regex(/^\d+$/, 'user_id must be a numeric string').optional(), // Only used for internal API calls
});

type SavePredictionPayload = z.infer<typeof savePredictionSchema>;

export async function POST(request: NextRequest) {
  // 1. Check authentication: internal API key OR session
  const isInternal = isInternalRequest(request);

  // Parse body first to potentially get user_id from internal calls
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationErrorResponse('Invalid JSON body');
  }

  let payload: SavePredictionPayload;
  try {
    payload = savePredictionSchema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      const msg = firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'Validation failed';
      
      return NextResponse.json({ 
        message: msg, 
        errors: error.issues.map(e => `${e.path.join('.')}: ${e.message}`)
      }, { status: 400 });
    }
    return validationErrorResponse('Validation failed');
  }

  let userId: string;

  if (!isInternal) {
    // External request: require origin check and session
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) return originCheckResponse;

    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return unauthorizedResponse('Authentication required');
    }
    const approvalOutcome = await checkApprovalGuard(session.user.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
    userId = session.user.id;
  } else {
    // Internal request: use user_id from payload
    if (!payload.user_id) {
      return validationErrorResponse('user_id is required for internal API calls');
    }
    userId = payload.user_id;
  }

  try {
    // 2. Resolve stock_id from ticker
    const stocks = await select('stocks', { symbol: payload.ticker });
    if (!stocks || stocks.length === 0) {
      logger.error('Stock not found', { ticker: payload.ticker, user_id: userId });
      return validationErrorResponse(`Stock not found: ${payload.ticker}`);
    }

    const stockId = (stocks[0] as any).id as number;

    // 3. Prepare upsert data
    // Format ISO string (2026-04-11T00:26:06.087Z) to MySQL format (2026-04-11 00:26:06.087)
    const isoString = payload.last_requested_at || new Date().toISOString();
    const mysqlDateTime = isoString.replace('T', ' ').replace('Z', '');
    
    const predictionData: any = {
      user_id: userId,
      stock_id: stockId,
      last_requested_at: mysqlDateTime,
    };

    // Surgical assignment: only include fields that were provided in the payload
    if (payload.predicted_price_1d !== undefined) predictionData.predicted_price_1d = payload.predicted_price_1d;
    if (payload.predicted_price_1m !== undefined) predictionData.predicted_price_1m = payload.predicted_price_1m;
    if (payload.predicted_price_6m !== undefined) predictionData.predicted_price_6m = payload.predicted_price_6m;
    if (payload.predicted_price_1y !== undefined) predictionData.predicted_price_1y = payload.predicted_price_1y;
    
    if (payload.macro_features_used !== undefined) {
      predictionData.macro_features_used = payload.macro_features_used ? JSON.stringify(payload.macro_features_used) : null;
    }
    if (payload.consumer_multiplier_applied !== undefined) {
      predictionData.consumer_multiplier_applied = payload.consumer_multiplier_applied;
    }

    // 4. Upsert into user_stock_predictions table
    // Unique key is (user_id, stock_id)
    await upsert('user_stock_predictions', predictionData, ['user_id', 'stock_id']);

    // 5. If a GPS score was provided, write to canonical table and sync recommended_stocks.
    if (payload.gps_score != null && payload.gps_score !== undefined) {
      const gpsBreakdownJson = payload.gps_breakdown ? JSON.stringify(payload.gps_breakdown) : null;

      // Read current score once; skip all writes if unchanged (DECIMAL(5,1) → compare at 1dp).
      const [sgsCheck] = await executeRawQuery(
        `SELECT gps_score FROM stock_gps_scores WHERE stock_id = ?`,
        [stockId]
      );
      const existingGps = (sgsCheck as any[])[0]?.gps_score;
      const gpsChanged = existingGps == null ||
        Math.round(parseFloat(existingGps) * 10) !== Math.round(payload.gps_score * 10);

      if (gpsChanged) {
        // Upsert canonical GPS score (one row per stock).
        await executeRawQuery(
          `INSERT INTO stock_gps_scores (stock_id, as_of, gps_score, gps_breakdown, model_version, regime, source)
           VALUES (?, ?, ?, ?, NULL, NULL, 'prediction_engine')
           ON DUPLICATE KEY UPDATE
             as_of         = VALUES(as_of),
             gps_score     = VALUES(gps_score),
             gps_breakdown = VALUES(gps_breakdown),
             model_version = VALUES(model_version),
             regime        = VALUES(regime),
             source        = VALUES(source)`,
          [stockId, mysqlDateTime, payload.gps_score, gpsBreakdownJson]
        );

        // Append to score history (INSERT IGNORE; NULL model_version rows are each unique in MySQL).
        await executeRawQuery(
          `INSERT IGNORE INTO stock_gps_score_history (stock_id, as_of, gps_score, gps_breakdown, model_version, regime, source)
           VALUES (?, ?, ?, ?, NULL, NULL, 'prediction_engine')`,
          [stockId, mysqlDateTime, payload.gps_score, gpsBreakdownJson]
        );

        // Legacy sync: keep recommended_stocks in step (no-op if ticker not present).
        const [updateResult]: any = await executeRawQuery(
          `UPDATE recommended_stocks r
           INNER JOIN (
             SELECT MAX(snapshot_date) AS max_date
             FROM recommended_stocks
             WHERE ticker = ?
           ) latest ON r.snapshot_date = latest.max_date
           SET r.gps_score = ?, r.gps_breakdown = ?
           WHERE r.ticker = ?`,
          [payload.ticker, payload.gps_score, gpsBreakdownJson, payload.ticker]
        );
        if (updateResult?.affectedRows > 0) {
          logger.info('recommended_stocks GPS score synced', {
            ticker: payload.ticker,
            gps_score: payload.gps_score,
            rows: updateResult.affectedRows,
          });
        }
      }
    }

    logger.info('Prediction saved successfully', {
      ticker: payload.ticker,
      stock_id: stockId,
      user_id: userId,
      predicted_price_1m: payload.predicted_price_1m,
    });

    return NextResponse.json(
      { message: 'Prediction saved successfully' },
      { status: 200 }
    );
  } catch (error) {
    logger.error('Failed to save prediction', {
      ticker: payload.ticker,
      user_id: userId,
      error: error instanceof Error ? error : String(error),
    });
    return createErrorResponse(
      error,
      'Failed to save prediction',
      { status: 500 }
    );
  }
}
