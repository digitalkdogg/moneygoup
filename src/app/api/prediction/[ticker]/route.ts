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
import { getClientIP } from '@/utils/rateLimitMiddleware';
import { predictionCache } from '@/utils/cache';

const logger = createLogger('api/prediction');

const COOLDOWN_MS = 30_000;
const tickerCooldown = new Map<string, number>();

function setCooldown(key: string): void {
  const now = Date.now();
  tickerCooldown.set(key, now);
  for (const [k, timestamp] of tickerCooldown.entries()) {
    if (now - timestamp > COOLDOWN_MS) tickerCooldown.delete(k);
  }
}

function isOnCooldown(key: string): boolean {
  const last = tickerCooldown.get(key);
  if (last === undefined) return false;
  return Date.now() - last < COOLDOWN_MS;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheck = checkOrigin(request);
    if (originCheck) return originCheck;
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return unauthorizedResponse('Authentication required');
    var userId = session.user.email || session.user.id;
    var ip = getClientIP(request);
  } else {
    var userId = 'internal';
    var ip = '127.0.0.1';
  }

  let validatedTicker: string;
  try {
    validatedTicker = tickerSchema.parse(params.ticker);
  } catch (error) {
    return validationErrorResponse('Invalid ticker');
  }

  const cooldownKey = `${userId}-${ip}-${validatedTicker}`;
  if (!isInternal && isOnCooldown(cooldownKey)) {
    const retryAfterMs = COOLDOWN_MS - (Date.now() - (tickerCooldown.get(cooldownKey) ?? 0));
    return NextResponse.json({ message: `Cooldown: ${Math.ceil(retryAfterMs / 1000)}s` }, { status: 429 });
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

  if (!isInternal) setCooldown(cooldownKey);

  const tempFile = join(tmpdir(), `tf_prediction_input_${randomUUID()}.json`);
  await predictionSemaphore.acquire();
  try {
    writeFileSync(tempFile, JSON.stringify(body));
    const result: any = await runPythonPrediction(validatedTicker, tempFile, validatedOutlook);
    
    predictionCache.set(`${validatedTicker}_${validatedOutlook}`, result);

    if (!isInternal && result.predicted_price_1m) {
      savePredictionAsync(validatedTicker, result.predicted_price_1m, userId).catch(() => {});
    }

    return NextResponse.json({ ...result, source: 'livedata' });
  } catch (error) {
    return createErrorResponse(error, 'Prediction failed', { status: 500 });
  } finally {
    predictionSemaphore.release();
    try { unlinkSync(tempFile); } catch {}
  }
}

function runPythonPrediction(ticker: string, inputFile: string, outlook: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['scripts/predict_weighted_analysis.py', ticker, '--input_file', inputFile, '--outlook', outlook]);
    let stdout = '', stderr = '';
    python.stdout.on('data', d => { stdout += d; });
    python.stderr.on('data', d => { stderr += d; });
    python.on('close', code => {
      if (code !== 0) return reject(new Error(`Exit ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid JSON')); }
    });
    python.on('error', err => reject(err));
  });
}

async function savePredictionAsync(ticker: string, price: number, userId: string) {
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
    await fetch(`${baseUrl}/api/prediction/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': baseUrl, ...(internalSecret && { 'x-api-key': internalSecret }) },
      body: JSON.stringify({ ticker, predicted_price_1m: price, user_id: userId }),
    });
  } catch {}
}
