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

const logger = createLogger('api/prediction');

// ---------------------------------------------------------------------------
// Rate-limiting: track the last prediction time per user+ticker combination.
//
// Keys are "${userId}-${ticker}" strings. The map is bounded — on every write
// we evict entries that are older than COOLDOWN_MS so the map doesn't grow
// unboundedly over the lifetime of the process. Without eviction, a large
// number of users each requesting many different tickers would accumulate
// entries indefinitely in server memory.
// ---------------------------------------------------------------------------
const COOLDOWN_MS = 30_000; // 30 seconds between predictions per user+ticker
const tickerCooldown = new Map<string, number>();

/**
 * Records a cooldown timestamp for `key` and evicts all expired entries.
 *
 * Eviction runs on every write (O(n) over current map size). The map is
 * expected to stay small in normal use — entries expire after 30 s, so size
 * is bounded by (active users × distinct tickers requested in the last 30 s).
 * The hard cap below provides a backstop for pathological traffic.
 */
function setCooldown(key: string): void {
  const now = Date.now();
  tickerCooldown.set(key, now);

  // Evict expired entries so the map stays bounded.
  // An entry is "expired" once its cooldown window has passed — it no longer
  // needs to be retained for rate-limit enforcement.
  for (const [k, timestamp] of tickerCooldown.entries()) {
    if (now - timestamp > COOLDOWN_MS) {
      tickerCooldown.delete(k);
    }
  }

  // Hard cap: if eviction still leaves the map very large (e.g. a burst of
  // unique keys all set in the same second), clear the whole map. All entries
  // set < 30 s ago would still be within their cooldown window, but a map
  // of 5 000+ concurrent rate-limited keys indicates abnormal traffic and
  // the clean slate is safer than unbounded memory growth.
  if (tickerCooldown.size > 5_000) {
    logger.warn('tickerCooldown map exceeded 5 000 entries — clearing', {
      size: tickerCooldown.size,
    });
    tickerCooldown.clear();
  }
}

function isOnCooldown(key: string): boolean {
  const last = tickerCooldown.get(key);
  if (last === undefined) return false;
  return Date.now() - last < COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function POST(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  // 1. Auth & Origin check
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) return originCheckResponse;

    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return unauthorizedResponse('Authentication required');
    }
    var userId = session.user.email || session.user.id;
    var ip = getClientIP(request);
  } else {
    var userId = 'internal';
    var ip = '127.0.0.1';
  }

  // 3. Validate ticker using schema
  try {
    var validatedTicker = tickerSchema.parse(params.ticker);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues && error.issues.length > 0 
        ? error.issues[0].message 
        : 'Invalid ticker';
      return validationErrorResponse(message);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  // 4. Per-user+ip+ticker rate limit (skip for internal)
  const cooldownKey = `${userId}-${ip}-${validatedTicker}`;
  if (!isInternal && isOnCooldown(cooldownKey)) {
    const retryAfterMs = COOLDOWN_MS - (Date.now() - (tickerCooldown.get(cooldownKey) ?? 0));
    return NextResponse.json(
      { message: `Please wait ${Math.ceil(retryAfterMs / 1000)} seconds before requesting another prediction for ${validatedTicker}.` },
      { status: 429 }
    );
  }

  // 5. Parse and validate body before checking concurrency
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate historicalData presence and minimum depth (504 rows ≈ 2 years)
  if (!body.historicalData || !Array.isArray(body.historicalData) || body.historicalData.length === 0) {
    return NextResponse.json({ message: 'historicalData is required and must be a non-empty array' }, { status: 400 });
  }
  if (body.historicalData.length < 504) {
    return NextResponse.json(
      { message: `Insufficient historical data: ${body.historicalData.length} days provided, minimum 504 required (~2 years).` },
      { status: 400 }
    );
  }
  if (!body.stockMetrics || typeof body.stockMetrics !== 'object') {
    return NextResponse.json({ message: 'stockMetrics is required' }, { status: 400 });
  }

  // 6. Concurrency limit — check before acquiring the slot
  if (predictionSemaphore.isFull()) {
    return NextResponse.json(
      { message: 'Prediction service is busy. Please try again in a moment.' },
      { status: 503 }
    );
  }

  // 7. Record cooldown before spawning (prevents double-submit races, skip for internal)
  if (!isInternal) {
    setCooldown(cooldownKey);
  }

  // 8. Extract outlook parameter (body first, then query, default to 'all')
  const outlook = (body.outlook || request.nextUrl.searchParams.get('outlook') || 'all').toString();
  const validOutlooks = ['1_month', '6_month', '1_year', 'all'];
  const validatedOutlook = validOutlooks.includes(outlook) ? outlook : 'all';

  // 9. Acquire semaphore slot, run prediction, release on completion
  const tempFile = join(tmpdir(), `tf_prediction_input_${randomUUID()}.json`);

  await predictionSemaphore.acquire();
  try {
    // Write input data to temp file.
    // Ticker is NOT included in the JSON — the Python script reads it from
    // the CLI positional argument, not from the file.
    writeFileSync(tempFile, JSON.stringify(body));

    // Python script CLI signature (predict_weighted_analysis.py argparse):
    //   python3 predict_weighted_analysis.py <ticker> --input_file <path> --outlook <outlook>
    const result = await runPythonPrediction(validatedTicker, tempFile, validatedOutlook);
    return NextResponse.json(result);
  } catch (error) {
    logger.error('Prediction failed', {
      ticker: validatedTicker,
      outlook: validatedOutlook,
      error: error instanceof Error ? error : String(error),
    });
    return createErrorResponse(error, 'Prediction failed', { status: 500 });
  } finally {
    predictionSemaphore.release();
    // Always clean up the temp file, even if the process was interrupted
    try {
      unlinkSync(tempFile);
    } catch {
      // File may not exist if writeFileSync failed — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn the Python prediction process and return its parsed JSON output.
// ---------------------------------------------------------------------------
function runPythonPrediction(ticker: string, inputFile: string, outlook: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const python = spawn(
      'python3',
      ['predict_weighted_analysis.py', ticker, '--input_file', inputFile, '--outlook', outlook],
      {
        cwd: process.cwd(),
        env: { ...process.env },
      }
    );

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    python.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    python.on('close', (code) => {
      if (code !== 0) {
        logger.error('Python process exited with non-zero code', {
          code,
          ticker,
          stderr: stderr, // Log full stderr, not truncated
        });
        reject(new Error(`Prediction process failed (exit code ${code}): ${stderr}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        logger.error('Failed to parse Python output', {
          ticker,
          stdout: stdout.substring(0, 500),
        });
        reject(new Error('Prediction process returned invalid JSON'));
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to start prediction process: ${err.message}`));
    });
  });
}