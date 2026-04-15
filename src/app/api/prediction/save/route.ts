// src/app/api/prediction/save/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { unauthorizedResponse, createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';
import { select, upsert } from '@/utils/databaseHelper';

const logger = createLogger('api/prediction/save');

// Validation schema for save payload
const savePredictionSchema = z.object({
  ticker: tickerSchema,
  predicted_price_1m: z.number().positive('predicted_price_1m must be a positive number'),
  last_requested_at: z.string().datetime().optional(),
  user_id: z.string().regex(/^\d+$/, 'user_id must be a numeric string').optional(), // Only used for internal API calls
});

type SavePredictionPayload = z.infer<typeof savePredictionSchema>;

export async function POST(request: NextRequest) {
  // 1. Check authentication: internal API key OR session
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

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
      const message = error.issues && error.issues.length > 0
        ? error.issues[0].message
        : 'Validation failed';
      return validationErrorResponse(message);
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
    
    const predictionData = {
      user_id: userId,
      stock_id: stockId,
      predicted_price_1m: payload.predicted_price_1m,
      last_requested_at: mysqlDateTime,
    };

    // 4. Upsert into user_stock_predictions table
    // Unique key is (user_id, stock_id)
    await upsert('user_stock_predictions', predictionData, ['user_id', 'stock_id']);

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
