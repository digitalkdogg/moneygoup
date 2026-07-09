// src/app/api/prediction/[ticker]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { isInternalRequest } from '@/utils/internalAuth';
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
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy';
import { recordPrediction } from '@/utils/predictionRecorder';

const logger = createLogger('api/prediction');


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const isInternal = isInternalRequest(request);

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

  // Parse body up front so we have stockMetrics available for GPS recomputation
  // on cache hits — the cached prediction is strategy-independent, but the GPS
  // it generates is not, so we must rerun the GPS step every request.
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
  const validOutlooks = ['1_week', '1_month', '6_month', '1_year', 'all'];
  const validatedOutlook = validOutlooks.includes(outlook) ? outlook : 'all';

  // Helper: compute GPS from a prediction result + body metrics. The GPS shown
  // to the user uses the user's investment_timeframe horizon for the ML upside
  // and confidence components. The 1m baseline is what we persist to
  // stock_gps_scores so the global table stays coherent across users.
  async function buildResponse(result: any, source: 'cache' | 'livedata') {
    let computedGps: ReturnType<typeof calculateGpsScore> | null = null;
    let baselineGps: ReturnType<typeof calculateGpsScore> | null = null;
    let gpsHorizon: '1_week' | '1_month' | '6_month' | '1_year' = '1_month';

    if (!isInternal && result?.predicted_price_1m) {
      const gpsMetrics = {
        analystUpside:     body.stockMetrics?.analystUpside,
        revenueGrowthPct:  body.stockMetrics?.revenueGrowth,
        earningsGrowthPct: body.stockMetrics?.earningsGrowth,
        priceChange52w:    body.stockMetrics?.fiftyTwoWeekChange,
        technicalScore:    body.technicalScore,
        recommendationKey: body.recommendationKey,
      };

      // 1m baseline: always computed, always saved to the global table.
      baselineGps = calculateGpsScore(gpsMetrics, {
        predictedChangePct1m: result.predicted_change_pct_1m,
        confidenceScore:      result.confidence_score_1m,
      });

      // Per-user horizon: pick the prediction matching the user's timeframe.
      const strategy = await getUserStrategy(userId).catch(() => DEFAULT_STRATEGY);
      gpsHorizon = strategy.investment_timeframe;
      const horizonKey = strategy.investment_timeframe.replace('_', ''); // '1week' / '1month' / '6month' / '1year'
      const suffixMap: Record<string, string> = { '1week': '1w', '1month': '1m', '6month': '6m', '1year': '1y' };
      const sfx = suffixMap[horizonKey] ?? '1m';
      const horizonChange = result[`predicted_change_pct_${sfx}`] ?? result.predicted_change_pct_1m;
      const horizonConfidence = result[`confidence_score_${sfx}`] ?? result.confidence_score_1m;

      computedGps = calculateGpsScore(gpsMetrics, {
        predictedChangePct1m: horizonChange,
        confidenceScore:      horizonConfidence,
      });

      // Persist the NEUTRAL 1m baseline globally (skip on cache hits).
      if (source === 'livedata') {
        savePredictionAsync(
          validatedTicker,
          result,
          userId,
          baselineGps.score,
          baselineGps.breakdown,
        ).catch(() => {});
      }
    }

    // Record to analytics prediction_records — only for the browser on-demand
    // flow (external caller, outlook='all', one call). The batch script also
    // uses outlook='all', but it's an internal caller that writes to
    // prediction_records itself via update_predictions.py's record_prediction()
    // (with model_version tag + gps derived Python-side). Gating on !isInternal
    // prevents writing the same row twice.
    if (source === 'livedata' && validatedOutlook === 'all' && !isInternal) {
      const priceAtPrediction = body.stockMetrics?.regularMarketPrice;
      if (priceAtPrediction) {
        recordPrediction({
          symbol: validatedTicker,
          priceAtPrediction,
          modelVersion: result.model_version,
          predictedPrice1w: result.predicted_price_1w,
          predictedPrice1m: result.predicted_price_1m,
          predictedPrice6m: result.predicted_price_6m,
          predictedPrice1y: result.predicted_price_1y,
          predictedChangePct1w: result.predicted_change_pct_1w,
          predictedChangePct1m: result.predicted_change_pct_1m,
          predictedChangePct6m: result.predicted_change_pct_6m,
          predictedChangePct1y: result.predicted_change_pct_1y,
          confidenceScore1w: result.confidence_score_1w,
          confidenceScore1m: result.confidence_score_1m,
          confidenceScore6m: result.confidence_score_6m,
          confidenceScore1y: result.confidence_score_1y,
          gpsScore: baselineGps?.score,
          gpsBreakdown: baselineGps?.breakdown,
          accuracyMetrics: result.accuracy_metrics,
          dataQuality: result.data_quality,
          modelStatus: result.model_status,
          atModelCeiling6m: result.at_model_ceiling_6m ?? null,
          atModelCeiling1y: result.at_model_ceiling_1y ?? null,
          ceilingDirection: result.ceiling_direction ?? null,
          confidenceBreakdown: result.confidence_breakdown,
          confidenceReason1w: result.confidence_reason_1w,
          confidenceReason1m: result.confidence_reason_1m,
          confidenceReason6m: result.confidence_reason_6m,
          confidenceReason1y: result.confidence_reason_1y,
        }).catch(() => {});
      }
    }

    // Surface which model produced this prediction in a top-level block so
    // it's easy to spot in the network tab while debugging A/B switches.
    // Derived from result.model_version (set by the model toggle code below
    // before buildResponse fires for fresh predictions; persisted on the
    // cached entry for cache hits).
    const tag: string | undefined = result.model_version;
    const modelInfo = {
      model_version: tag ?? null,
      use_legacy_model: tag === 'legacy',
      cs_model_version: typeof tag === 'string' && tag.startsWith('v3split_')
        ? tag.split('_').slice(1).join('_')
        : null,
      source,
    };

    return NextResponse.json({
      ...result,
      source,
      model_info: modelInfo,
      ...(computedGps && {
        gps_score: computedGps.score,
        gps_breakdown: computedGps.breakdown,
        gps_horizon: gpsHorizon,
      }),
    });
  }

  // Model toggle (env-driven, for A/B testing the v3-split + cross-sectional
  // model against the pre-refactor baseline). Set USE_LEGACY_PREDICTION_MODEL=true
  // in .env.local to route to scripts/predict_weighted_analysis_baseline.py.
  // Anything else (default) uses the new orchestrator. We include the model
  // tag in the cache key so flipping the env var produces a fresh prediction
  // instead of returning the prior model's cached result.
  const useLegacyModel = process.env.USE_LEGACY_PREDICTION_MODEL === 'true';
  // Include CS_MODEL_VERSION (v1/v2/...) in the cache key — when we promote a
  // new CS model, switching the default must invalidate prior cached results.
  const csModelVersion = process.env.CS_MODEL_VERSION || 'v2';
  const modelTag = useLegacyModel ? 'legacy' : `v3split_${csModelVersion}`;

  if (!forceRefresh) {
    const cacheKey = `${validatedTicker}_${queryOutlook}_${modelTag}`;
    const cachedData = predictionCache.get(cacheKey);
    if (cachedData) {
      return buildResponse(cachedData, 'cache');
    }
  }

  if (predictionSemaphore.isFull()) {
    return NextResponse.json({ message: 'Busy' }, { status: 503 });
  }

  const tempFile = join(tmpdir(), `tf_prediction_input_${randomUUID()}.json`);
  await predictionSemaphore.acquire();
  try {
    writeFileSync(tempFile, JSON.stringify(body));
    const result: any = await runPythonPrediction(validatedTicker, tempFile, validatedOutlook, useLegacyModel, csModelVersion);
    // Tag the result so callers (and the cache) can tell which model produced
    // it. Useful when comparing legacy vs v3-split in the UI / dev logs.
    result.model_version = modelTag;

    // Ensure generic keys are populated for the requested outlook
    if (validatedOutlook === '1_month') {
      result.predicted_change_pct = result.predicted_change_pct ?? result.predicted_change_pct_1m;
      result.confidence_score = result.confidence_score ?? result.confidence_score_1m;
      result.predicted_price = result.predicted_price ?? result.predicted_price_1m;
      // Also ensure specific key exists for backward compatibility
      result.predicted_price_1m = result.predicted_price_1m ?? result.predicted_price;
      result.predicted_change_pct_1m = result.predicted_change_pct_1m ?? result.predicted_change_pct;
      result.confidence_score_1m = result.confidence_score_1m ?? result.confidence_score;
    } else if (validatedOutlook === '1_week') {
      result.predicted_change_pct = result.predicted_change_pct ?? result.predicted_change_pct_1w;
      result.confidence_score = result.confidence_score ?? result.confidence_score_1w;
      result.predicted_price = result.predicted_price ?? result.predicted_price_1w;
      result.predicted_price_1w = result.predicted_price_1w ?? result.predicted_price;
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
    predictionCache.set(`${validatedTicker}_${validatedOutlook}_${modelTag}`, result);

    return buildResponse(result, 'livedata');
  } catch (error) {
    return createErrorResponse(error, 'Prediction failed', { status: 500 });
  } finally {
    predictionSemaphore.release();
    try { unlinkSync(tempFile); } catch {}
  }
}

function runPythonPrediction(ticker: string, inputFile: string, outlook: string, useLegacy: boolean = false, csModelVersion: string = 'v2'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Legacy = the frozen pre-refactor monolithic 4-output MLP. v3-split =
    // the current orchestrator (cross-sectional long-term + per-ticker short-term).
    const scriptName = useLegacy
      ? 'scripts/predict_weighted_analysis_baseline.py'
      : 'scripts/predict_weighted_analysis.py';
    logger.info(`Predict (${useLegacy ? 'LEGACY' : 'v3-split'}) ${ticker} outlook=${outlook}`);
    // Pass env explicitly. Turbopack sometimes doesn't forward .env.local
    // values into the OS process env that child_process.spawn inherits, so
    // Python defaults to CS_MODEL_VERSION=v2 even when .env.local says v1.
    // Use the already-resolved `csModelVersion` and `useLegacyModel` from the
    // top of the handler (line 228) — those we know took .env.local into
    // account because modelTag was derived from them correctly.
    logger.info(`[spawn] forwarding CS_MODEL_VERSION=${csModelVersion} USE_LEGACY=${useLegacy}`);
    const python = spawn(getPythonExecutable(), [scriptName, ticker, '--input_file', inputFile, '--outlook', outlook], {
      env: {
        ...process.env,
        CS_MODEL_VERSION: csModelVersion,
        USE_LEGACY_PREDICTION_MODEL: useLegacy ? 'true' : 'false',
      },
    });
    let stdout = '', stderr = '';
    python.stdout.on('data', d => { stdout += d; });
    python.stderr.on('data', d => { stderr += d; });
    python.on('close', code => {
      if (code !== 0) {
        logger.error(`Python prediction crashed for ${ticker}`, {
          ticker,
          exitCode: code,
          stderrTail: stderr.slice(-4000),
          stdoutTail: stdout.slice(-500),
        });
        return reject(new Error(`Exit ${code}: ${stderr}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        logger.info(`Python prediction raw output for ${ticker}`, { parsed });
        // Surface Python stderr on success too — needed to trace env var
        // propagation / model version loading issues.
        if (stderr) {
          logger.info(`[python stderr] ${ticker}`, { stderrTail: stderr.slice(-2000) });
        }
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
  result: any,
  userId: string,
  gpsScore?: number,
  gpsBreakdown?: any,
) {
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : v != null ? parseFloat(String(v)) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    const positive = (v: unknown): number | undefined => {
      const n = num(v);
      return n != null && n > 0 ? n : undefined;
    };
    await fetch(`${baseUrl}/api/prediction/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': baseUrl,
        ...(internalSecret && { 'x-api-key': internalSecret })
      },
      body: JSON.stringify({
        ticker,
        predicted_price_1m: result.predicted_price_1m,
        predicted_price_1w: positive(result.predicted_price_1w),
        predicted_price_6m: positive(result.predicted_price_6m),
        predicted_price_1y: positive(result.predicted_price_1y),
        predicted_change_pct_1w: num(result.predicted_change_pct_1w),
        predicted_change_pct_1m: num(result.predicted_change_pct_1m),
        predicted_change_pct_6m: num(result.predicted_change_pct_6m),
        predicted_change_pct_1y: num(result.predicted_change_pct_1y),
        confidence_score_1w: num(result.confidence_score_1w),
        confidence_score_1m: num(result.confidence_score_1m),
        confidence_score_6m: num(result.confidence_score_6m),
        confidence_score_1y: num(result.confidence_score_1y),
        user_id: userId,
        gps_score: gpsScore,
        gps_breakdown: gpsBreakdown,
      }),
    });
  } catch {}
}
