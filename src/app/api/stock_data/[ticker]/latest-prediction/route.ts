import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';

const logger = createLogger('api/stock_data/[ticker]/latest-prediction');

// Mirror the model-tag logic in src/app/api/prediction/[ticker]/route.ts so the
// freshness read only surfaces predictions from the currently-active model.
// Old rows written under prior model_versions are ignored.
function currentModelVersion(): string {
  const useLegacy = process.env.USE_LEGACY_PREDICTION_MODEL === 'true';
  const csVersion = process.env.CS_MODEL_VERSION || 'v2';
  return useLegacy ? 'legacy' : `v3split_${csVersion}`;
}

function parseJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const originCheck = checkOrigin(request);
  if (originCheck) return originCheck;

  const { ticker: rawTicker } = await params;
  const parsed = tickerSchema.safeParse(rawTicker);
  if (!parsed.success) {
    return NextResponse.json(null);
  }
  const ticker = parsed.data;

  try {
    const [rows] = await executeRawQuery(
      `SELECT
         symbol, predicted_at, model_version, price_at_prediction,
         predicted_price_1w, predicted_price_1m, predicted_price_3m, predicted_price_6m,
         predicted_change_pct_1w, predicted_change_pct_1m, predicted_change_pct_3m, predicted_change_pct_6m,
         confidence_score_1w, confidence_score_1m, confidence_score_3m, confidence_score_6m,
         gps_score, gps_breakdown,
         accuracy_metrics, data_quality, model_status,
         at_model_ceiling_3m, at_model_ceiling_6m, ceiling_direction,
         confidence_breakdown,
         confidence_reason_1w, confidence_reason_1m, confidence_reason_3m, confidence_reason_6m,
         llm_rationale,
         created_at
       FROM prediction_records
       WHERE symbol = ?
         AND model_version = ?
         AND created_at >= NOW() - INTERVAL 12 HOUR
       ORDER BY created_at DESC
       LIMIT 1`,
      [ticker, currentModelVersion()]
    );

    const row = (rows as Record<string, unknown>[])[0];
    if (!row) {
      return NextResponse.json(null);
    }

    const numeric = (v: unknown): number | null =>
      v == null ? null : Number(v);

    const createdAt = row.created_at ? new Date(String(row.created_at)) : null;
    const ageMinutes = createdAt
      ? Math.round((Date.now() - createdAt.getTime()) / 60000)
      : null;

    const prediction = {
      ticker,
      regularMarketPrice: numeric(row.price_at_prediction),
      predicted_price_1w: numeric(row.predicted_price_1w),
      predicted_price_1m: numeric(row.predicted_price_1m),
      predicted_price_3m: numeric(row.predicted_price_3m),
      predicted_price_6m: numeric(row.predicted_price_6m),
      predicted_change_pct_1w: numeric(row.predicted_change_pct_1w),
      predicted_change_pct_1m: numeric(row.predicted_change_pct_1m),
      predicted_change_pct_3m: numeric(row.predicted_change_pct_3m),
      predicted_change_pct_6m: numeric(row.predicted_change_pct_6m),
      confidence_score_1w: numeric(row.confidence_score_1w),
      confidence_score_1m: numeric(row.confidence_score_1m),
      confidence_score_3m: numeric(row.confidence_score_3m),
      confidence_score_6m: numeric(row.confidence_score_6m),
      gps_score: numeric(row.gps_score),
      gps_breakdown: parseJson(row.gps_breakdown),
      accuracy_metrics: parseJson(row.accuracy_metrics),
      data_quality: parseJson(row.data_quality),
      model_status: row.model_status ?? null,
      at_model_ceiling_3m: row.at_model_ceiling_3m == null ? null : Number(row.at_model_ceiling_3m) === 1,
      at_model_ceiling_6m: row.at_model_ceiling_6m == null ? null : Number(row.at_model_ceiling_6m) === 1,
      ceiling_direction: (row.ceiling_direction as 'up' | 'down' | null) ?? null,
      confidence_breakdown: parseJson(row.confidence_breakdown),
      confidence_reason_1w: (row.confidence_reason_1w as string | null) ?? undefined,
      confidence_reason_1m: (row.confidence_reason_1m as string | null) ?? undefined,
      confidence_reason_3m: (row.confidence_reason_3m as string | null) ?? undefined,
      confidence_reason_6m: (row.confidence_reason_6m as string | null) ?? undefined,
      llm_rationale: (row.llm_rationale as string | null) ?? null,
      model_version: row.model_version,
    };

    return NextResponse.json({
      prediction,
      predictedAt: row.predicted_at ? new Date(String(row.predicted_at)).toISOString() : null,
      createdAt: createdAt ? createdAt.toISOString() : null,
      ageMinutes,
    });
  } catch (err) {
    logger.error('latest-prediction query failed', {
      ticker,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(null);
  }
}
