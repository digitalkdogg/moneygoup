import { NextRequest, NextResponse } from 'next/server';
import { checkOrigin } from '@/utils/originCheck';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';
import { executeRawQuery } from '@/utils/databaseHelper';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getPythonExecutable } from '@/utils/pythonPath';
import { isOllamaEnabled } from '@/utils/ollamaClient';

const logger = createLogger('api/prediction/rationale');

// Mirror the model-tag logic used by the prediction route.
function currentModelVersion(): string {
  const useLegacy = process.env.USE_LEGACY_PREDICTION_MODEL === 'true';
  const csVersion = process.env.CS_MODEL_VERSION || 'v2';
  return useLegacy ? 'legacy' : `v3split_${csVersion}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const originCheck = checkOrigin(request);
  if (originCheck) return originCheck;

  if (!isOllamaEnabled()) {
    return NextResponse.json({ error: 'AI narration is disabled.' }, { status: 503 });
  }

  const { ticker: rawTicker } = await params;
  const parsed = tickerSchema.safeParse(rawTicker);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid ticker.' }, { status: 400 });
  }
  const ticker = parsed.data;

  // Fetch the latest prediction record for this ticker.
  let row: Record<string, unknown> | null = null;
  try {
    const [rows] = await executeRawQuery(
      `SELECT predicted_change_pct_3m, predicted_change_pct_6m,
              confidence_reason_3m, confidence_reason_6m
       FROM prediction_records
       WHERE symbol = ? AND model_version = ?
         AND created_at >= NOW() - INTERVAL 12 HOUR
       ORDER BY created_at DESC LIMIT 1`,
      [ticker, currentModelVersion()],
    );
    row = (rows as Record<string, unknown>[])[0] ?? null;
  } catch (err) {
    logger.error('rationale: DB read failed', { ticker, error: String(err) });
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }

  if (!row) {
    return NextResponse.json(
      { error: 'No recent prediction found for this ticker.' },
      { status: 404 },
    );
  }

  // Build a minimal result dict from stored prediction fields.
  const result = {
    predicted_change_pct_3m: row.predicted_change_pct_3m ?? null,
    predicted_change_pct_6m: row.predicted_change_pct_6m ?? null,
    confidence_reason_3m:    row.confidence_reason_3m    ?? null,
    confidence_reason_6m:    row.confidence_reason_6m    ?? null,
  };

  const tmpFile = join(tmpdir(), `rationale_${randomUUID()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify({ result, analyst_rating: null }));
  } catch (err) {
    logger.error('rationale: failed to write temp file', { ticker, error: String(err) });
    return NextResponse.json({ error: 'Server error.' }, { status: 500 });
  }

  // Run generate_rationale.py synchronously (awaited, not detached).
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        getPythonExecutable(),
        ['scripts/generate_rationale.py', ticker, '--result-file', tmpFile],
        { env: { ...process.env }, stdio: 'ignore' },
      );
      const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 40_000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`exit code ${code}`));
      });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  } catch (err) {
    logger.error('rationale: subprocess failed', { ticker, error: String(err) });
    return NextResponse.json({ error: 'Narration failed. Try again.' }, { status: 500 });
  }

  // Read the updated rationale back from DB.
  try {
    const [rows] = await executeRawQuery(
      `SELECT llm_rationale FROM prediction_records
       WHERE symbol = ? AND model_version = ?
         AND created_at >= NOW() - INTERVAL 12 HOUR
       ORDER BY created_at DESC LIMIT 1`,
      [ticker, currentModelVersion()],
    );
    const updated = (rows as Record<string, unknown>[])[0];
    const rationale = (updated?.llm_rationale as string | null) ?? null;
    if (!rationale) {
      return NextResponse.json({ error: 'Narration produced no output.' }, { status: 500 });
    }
    return NextResponse.json({ rationale });
  } catch (err) {
    logger.error('rationale: DB read-back failed', { ticker, error: String(err) });
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
