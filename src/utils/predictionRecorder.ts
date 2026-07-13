import { getDbConnection } from './db';
import { createLogger } from './logger';

const logger = createLogger('predictionRecorder');

export interface PredictionInput {
  symbol: string;
  priceAtPrediction: number;
  modelVersion?: string;
  predictedPrice1w?: number;
  predictedPrice1m?: number;
  predictedPrice6m?: number;
  predictedPrice1y?: number;
  predictedChangePct1w?: number;
  predictedChangePct1m?: number;
  predictedChangePct6m?: number;
  predictedChangePct1y?: number;
  confidenceScore1w?: number;
  confidenceScore1m?: number;
  confidenceScore6m?: number;
  confidenceScore1y?: number;
  gpsScore?: number;
  gpsBreakdown?: unknown;
  accuracyMetrics?: unknown;
  dataQuality?: unknown;
  modelStatus?: string | null;
  atModelCeiling6m?: boolean | null;
  atModelCeiling1y?: boolean | null;
  ceilingDirection?: 'up' | 'down' | null;
  confidenceBreakdown?: unknown;
  confidenceReason1w?: string | null;
  confidenceReason1m?: string | null;
  confidenceReason6m?: string | null;
  confidenceReason1y?: string | null;
  /** Optional LLM-written narrative that sits alongside the rule-based
   *  confidence_reason_{h} strings. NULL when Ollama is disabled/down;
   *  the UI falls back to confidence_reason_{h} in that case. */
  llmRationale?: string | null;
}

export async function recordPrediction(input: PredictionInput): Promise<boolean> {
  try {
    const pool = await getDbConnection();
    const conn = await pool.getConnection();

    try {
      const query = `
        INSERT INTO prediction_records (
          symbol, predicted_at, model_version, price_at_prediction,
          predicted_price_1w, predicted_price_1m, predicted_price_6m, predicted_price_1y,
          predicted_change_pct_1w, predicted_change_pct_1m, predicted_change_pct_6m, predicted_change_pct_1y,
          confidence_score_1w, confidence_score_1m, confidence_score_6m, confidence_score_1y,
          gps_score, gps_breakdown,
          accuracy_metrics, data_quality, model_status,
          at_model_ceiling_6m, at_model_ceiling_1y, ceiling_direction,
          confidence_breakdown,
          confidence_reason_1w, confidence_reason_1m, confidence_reason_6m, confidence_reason_1y,
          llm_rationale
        ) VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const gpsBreakdownJson =
        input.gpsBreakdown != null ? JSON.stringify(input.gpsBreakdown) : null;
      const accuracyMetricsJson =
        input.accuracyMetrics != null ? JSON.stringify(input.accuracyMetrics) : null;
      const dataQualityJson =
        input.dataQuality != null ? JSON.stringify(input.dataQuality) : null;
      const confidenceBreakdownJson =
        input.confidenceBreakdown != null ? JSON.stringify(input.confidenceBreakdown) : null;

      const result = await conn.execute(query, [
        input.symbol,
        input.modelVersion ?? 'legacy',
        input.priceAtPrediction,
        input.predictedPrice1w ?? null,
        input.predictedPrice1m ?? null,
        input.predictedPrice6m ?? null,
        input.predictedPrice1y ?? null,
        input.predictedChangePct1w ?? null,
        input.predictedChangePct1m ?? null,
        input.predictedChangePct6m ?? null,
        input.predictedChangePct1y ?? null,
        input.confidenceScore1w ?? null,
        input.confidenceScore1m ?? null,
        input.confidenceScore6m ?? null,
        input.confidenceScore1y ?? null,
        input.gpsScore ?? null,
        gpsBreakdownJson,
        accuracyMetricsJson,
        dataQualityJson,
        input.modelStatus ?? null,
        input.atModelCeiling6m == null ? null : (input.atModelCeiling6m ? 1 : 0),
        input.atModelCeiling1y == null ? null : (input.atModelCeiling1y ? 1 : 0),
        input.ceilingDirection ?? null,
        confidenceBreakdownJson,
        input.confidenceReason1w ?? null,
        input.confidenceReason1m ?? null,
        input.confidenceReason6m ?? null,
        input.confidenceReason1y ?? null,
        input.llmRationale ?? null,
      ]);

      // @ts-ignore - mysql2 result type
      if (result[0].affectedRows > 0) {
        logger.info(`Prediction recorded for ${input.symbol}`, {
          symbol: input.symbol,
          modelVersion: input.modelVersion ?? 'legacy',
        });
        return true;
      }
      return false;
    } finally {
      conn.release();
    }
  } catch (error) {
    logger.error('Failed to record prediction', { symbol: input.symbol, error });
    return false;
  }
}
