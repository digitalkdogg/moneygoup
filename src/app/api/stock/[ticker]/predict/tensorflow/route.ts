import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { promises as fs } from 'fs' // Import promises version of fs
import path from 'path' // Import path module
import { randomUUID } from 'crypto';
import { predictionSemaphore } from '@/utils/predictionQueue';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import
import { predictionLimiter } from '@/utils/rateLimiter'; // Add this import

const logger = createLogger('api/stock/[ticker]/predict/tensorflow');

// Optional: Per-ticker cooldown (30 seconds)
const tickerCooldown = new Map<string, number>();
const COOLDOWN_MS = 30 * 1000; // 30 seconds

// NOTE: This endpoint requires authentication.
export async function POST( // Changed GET to POST
  request: Request,
  { params }: { params: { ticker: string } }
) {
  const ticker = params.ticker

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  // --- Rate Limiting for Prediction Endpoint ---
  const userId = session.user.id;
  const { allowed, resetInMs } = predictionLimiter.check(userId);

  if (!allowed) {
    return NextResponse.json(
      { message: `Too many prediction requests. Please try again in ${Math.ceil(resetInMs / 1000)} seconds.` },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(resetInMs / 1000)) } }
    );
  }

  // --- Per-ticker Cooldown ---
  const lastPredictionTime = tickerCooldown.get(`${userId}-${ticker}`);
  const now = Date.now();

  if (lastPredictionTime && (now - lastPredictionTime < COOLDOWN_MS)) {
    const remainingCooldown = COOLDOWN_MS - (now - lastPredictionTime);
    return NextResponse.json(
      { message: `Please wait ${Math.ceil(remainingCooldown / 1000)} seconds before predicting ${ticker} again.` },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(remainingCooldown / 1000)) } }
    );
  }
  tickerCooldown.set(`${userId}-${ticker}`, now);

  if (!ticker) {
    return NextResponse.json({ message: 'Ticker is required' }, { status: 400 })
  }

  // Validate ticker against allowed characters to prevent path traversal or command injection
  const tickerRegex = /^[A-Z0-9.^]{1,10}$/;
  if (!tickerRegex.test(ticker)) {
    return NextResponse.json({ message: 'Invalid ticker format' }, { status: 400 });
  }

  // Concurrency check — reject immediately if at capacity
  if (predictionSemaphore.isFull()) {
    return NextResponse.json(
      { message: 'Prediction service busy. Please try again shortly.' },
      { status: 503, headers: { 'Retry-After': '10' } }
    );
  }

  const tempFilePath = path.join('/tmp', `tf_prediction_input_${randomUUID()}.json`);

  // Determine Python executable path
  const pythonExecutable = process.env.PYPROCESS_URL || 'python3';

  let killTimer: NodeJS.Timeout | undefined;

  await predictionSemaphore.acquire();

  try {
    const requestBody = await request.json(); // Read request body

    // Write the request body to a temporary file
    await fs.writeFile(tempFilePath, JSON.stringify(requestBody));

    const result = await new Promise<NextResponse>((resolve) => {
      let pythonProcess = spawn(pythonExecutable, [
        'predict_weighted_analysis.py',
        ticker,
        '--input_file', tempFilePath
      ]);

      // Kill the process after 30 seconds and return a 504
      killTimer = setTimeout(() => {
        logger.warn('Prediction process timed out, sending SIGTERM.', { ticker, tempFilePath });
        pythonProcess.kill('SIGTERM');
        // Give it 2s to terminate gracefully, then force-kill
        setTimeout(() => {
          if (!pythonProcess.killed) {
            logger.error('Prediction process did not terminate gracefully, sending SIGKILL.', { ticker, tempFilePath });
            pythonProcess.kill('SIGKILL');
          }
        }, 2000);
        resolve(NextResponse.json(
          { message: 'Prediction timed out. Please try again.' },
          { status: 504 }
        ));
      }, 30_000); // 30 seconds

      let stdoutData = ''
      let stderrData = ''

      pythonProcess.stdout.on('data', (chunk) => { stdoutData += chunk; });
      pythonProcess.stderr.on('data', (chunk) => { stderrData += chunk; });

      pythonProcess.on('close', (code) => {
        clearTimeout(killTimer); // Clear the timeout if the process closes

        if (code !== 0) {
          logger.error('Prediction process failed', { code, stderr: stderrData, ticker, tempFilePath });
          resolve(NextResponse.json({ message: 'Prediction failed' }, { status: 500 }));
          return;
        }
        try {
          const prediction = JSON.parse(stdoutData);
          resolve(NextResponse.json(prediction));
        } catch (e) {
          logger.error('Failed to parse python script output', { stdout: stdoutData, error: e instanceof Error ? e.message : String(e), ticker, tempFilePath });
          resolve(NextResponse.json({ message: 'Invalid prediction output' }, { status: 500 }));
        }
      });

      pythonProcess.on('error', (err) => {
        clearTimeout(killTimer); // Clear the timeout if the process errors
        logger.error('Failed to spawn prediction process', { err, ticker, tempFilePath });
        resolve(NextResponse.json({ message: 'Prediction unavailable' }, { status: 503 }));
      });
    });

    return result;

  } catch (e) {
    logger.error('Error in Next.js API route for prediction', { error: e instanceof Error ? e.message : String(e), ticker });
    clearTimeout(killTimer); // Clear timer if error occurs before promise is created or resolved
    return NextResponse.json({ message: 'Error processing prediction request' }, { status: 500 });
  } finally {
    predictionSemaphore.release();
    // Always clean up the temp file — even if spawn threw, even if we timed out
    await fs.unlink(tempFilePath).catch((fileErr) => {
      // Ignore if file doesn't exist yet or already deleted
      logger.warn('Failed to delete temporary file, it might not exist or was already deleted.', { tempFilePath, error: fileErr instanceof Error ? fileErr.message : String(fileErr) });
    });
  }
}

