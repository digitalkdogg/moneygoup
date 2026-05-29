// src/app/api/prediction/[ticker]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { unauthorizedResponse, createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { predictionSemaphore } from '@/utils/predictionQueue';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';
import { getPythonExecutable } from '@/utils/pythonPath';
import { predictionCache } from '@/utils/cache';
import { calculateGpsScore } from '@/utils/gps';
import { LimitService } from '@/utils/limitService';
import { checkApprovalGuard } from '@/utils/approvalStatus';

const logger = createLogger('api/prediction');


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheck = checkOrigin(request);
    if (originCheck) return originCheck;
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return unauthorizedResponse('Authentication required');
    const approvalOutcome = await checkApprovalGuard(session.user.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
    var userId = session.user.id;
    var userRole = (session.user as any).role || 'user';

    // Check role-based lookup limits
    const limitCheck = await LimitService.canPerformLookup(userId, userRole);
    if (!limitCheck.allowed) {
      logger.warn('Lookup limit exceeded in prediction API', { userId, userRole });
      return NextResponse.json(
        {
          code: 'LIMIT_EXCEEDED',
          dimension: 'lookups',
          allowed: limitCheck.max,
          current: limitCheck.current,
          message: `Lookup limit exceeded. Your current limit is ${limitCheck.max} lookups per 24h.`
        },
        { status: 403 }
      );
    }
  } else {
    var userId = 'internal';
  }

  let validatedTicker: string;
  try {
    const resolvedParams = await params;
    validatedTicker = tickerSchema.parse(resolvedParams.ticker);
  } catch (error) {
    return validationErrorResponse('Invalid ticker');
  }

  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';
  const queryOutlook = searchParams.get('outlook') || 'all';

  if (!forceRefresh) {
    const cacheKey = `${validatedTicker}_${queryOutlook}`;
    const cachedData = predictionCache.get(cacheKey);
    if (cachedData) {
      return NextResponse.json({ ...cachedData as any, source: 'cache' });
    }
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.historicalData || !Array.isArray(body.historicalData) || body.historicalData.length < 365) {
    return validationErrorResponse('Insufficient historical data');
  }

  if (!body.stockMetrics || typeof body.stockMetrics !== 'object') {
    return validationErrorResponse('Missing or invalid stockMetrics');
  }

  const outlook = (body.outlook || queryOutlook).toString();
  const validOutlooks = ['1_day', '1_month', '6_month', '1_year', 'all'];
  const validatedOutlook = validOutlooks.includes(outlook) ? outlook : 'all';

  if (predictionSemaphore.isFull()) {
    return NextResponse.json({ message: 'Busy' }, { status: 503 });
  }

  const tempFile = join(tmpdir(), `tf_prediction_input_${randomUUID()}.json`);
  await predictionSemaphore.acquire();
  try {
    writeFileSync(tempFile, JSON.stringify(body));
    const result: any = await runPythonPrediction(validatedTicker, tempFile, validatedOutlook);
    
    // Ensure generic keys are populated for the requested outlook
    if (validatedOutlook === '1_month') {
      result.predicted_change_pct = result.predicted_change_pct ?? result.predicted_change_pct_1m;
      result.confidence_score = result.confidence_score ?? result.confidence_score_1m;
      result.predicted_price = result.predicted_price ?? result.predicted_price_1m;
      // Also ensure specific key exists for backward compatibility
      result.predicted_price_1m = result.predicted_price_1m ?? result.predicted_price;
      result.predicted_change_pct_1m = result.predicted_change_pct_1m ?? result.predicted_change_pct;
      result.confidence_score_1m = result.confidence_score_1m ?? result.confidence_score;
    } else if (validatedOutlook === '1_day') {
      result.predicted_change_pct = result.predicted_change_pct ?? result.predicted_change_pct_1d;
      result.confidence_score = result.confidence_score ?? result.confidence_score_1d;
      result.predicted_price = result.predicted_price ?? result.predicted_price_1d;
      result.predicted_price_1d = result.predicted_price_1d ?? result.predicted_price;
    } else if (validatedOutlook === '6_month') {
      result.predicted_change_pct = result.predicted_change_pct ?? result.predicted_change_pct_6m;
      result.confidence_score = result.confidence_score ?? result.confidence_score_6m;
      result.predicted_price = result.predicted_price ?? result.predicted_price_6m;
      result.predicted_price_6m = result.predicted_price_6m ?? result.predicted_price;
    } else if (validatedOutlook === '1_year') {
      result.predicted_change_pct = result.predicted_change_pct ?? result.predicted_change_pct_1y;
      result.confidence_score = result.confidence_score ?? result.confidence_score_1y;
      result.predicted_price = result.predicted_price ?? result.predicted_price_1y;
      result.predicted_price_1y = result.predicted_price_1y ?? result.predicted_price;
    }
    predictionCache.set(`${validatedTicker}_${validatedOutlook}`, result);

    let computedGps: ReturnType<typeof calculateGpsScore> | null = null
    if (!isInternal && result.predicted_price_1m) {
      computedGps = calculateGpsScore(
        {
          analystUpside: body.stockMetrics?.analystUpside,
          revenueGrowth: body.stockMetrics?.revenueGrowth,
          earningsGrowth: body.stockMetrics?.earningsGrowth,
          fiftyTwoWeekChange: body.stockMetrics?.fiftyTwoWeekChange
        },
        {
          predicted_change_pct: result.predicted_change_pct_1m,
          confidence_score: result.confidence_score_1m
        }
      );

      savePredictionAsync(
        validatedTicker,
        result.predicted_price_1m,
        userId,
        computedGps.score,
        computedGps.breakdown
      ).catch(() => {});
    }

    return NextResponse.json({
      ...result,
      source: 'livedata',
      ...(computedGps && { gps_score: computedGps.score, gps_breakdown: computedGps.breakdown }),
    });
  } catch (error) {
    return createErrorResponse(error, 'Prediction failed', { status: 500 });
  } finally {
    predictionSemaphore.release();
    try { unlinkSync(tempFile); } catch {}
  }
}

function runPythonPrediction(ticker: string, inputFile: string, outlook: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const python = spawn(getPythonExecutable(), ['scripts/predict_weighted_analysis.py', ticker, '--input_file', inputFile, '--outlook', outlook]);
    let stdout = '', stderr = '';
    python.stdout.on('data', d => { stdout += d; });
    python.stderr.on('data', d => { stderr += d; });
    python.on('close', code => {
      if (code !== 0) return reject(new Error(`Exit ${code}: ${stderr}`));
      try { 
        const parsed = JSON.parse(stdout);
        logger.info(`Python prediction raw output for ${ticker}`, { parsed });
        resolve(parsed); 
      } catch { 
        reject(new Error('Invalid JSON')); 
      }
    });
    python.on('error', err => reject(err));
  });
}

async function savePredictionAsync(
  ticker: string, 
  price: number, 
  userId: string, 
  gpsScore?: number, 
  gpsBreakdown?: any
) {
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
    await fetch(`${baseUrl}/api/prediction/save`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Origin': baseUrl, 
        ...(internalSecret && { 'x-api-key': internalSecret }) 
      },
      body: JSON.stringify({ 
        ticker, 
        predicted_price_1m: price, 
        user_id: userId,
        gps_score: gpsScore,
        gps_breakdown: gpsBreakdown
      }),
    });
  } catch {}
}
