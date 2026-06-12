import { getDbConnection } from './db';
import { createLogger } from './logger';

const logger = createLogger('predictionRecorder');

export interface PredictionInput {
  symbol: string;
  priceAtPrediction: number;
  predictedPrice1w?: number;
  predictedPrice1m?: number;
  predictedPrice6m?: number;
  predictedPrice1y?: number;
}

export async function recordPrediction(input: PredictionInput): Promise<boolean> {
  try {
    const pool = await getDbConnection();
    const conn = await pool.getConnection();

    try {
      const query = `
        INSERT IGNORE INTO prediction_records (
          symbol, predicted_at, price_at_prediction,
          predicted_price_1w, predicted_price_1m, predicted_price_6m, predicted_price_1y
        ) VALUES (?, CURDATE(), ?, ?, ?, ?, ?)
      `;

      const result = await conn.execute(query, [
        input.symbol,
        input.priceAtPrediction,
        input.predictedPrice1w ?? null,
        input.predictedPrice1m ?? null,
        input.predictedPrice6m ?? null,
        input.predictedPrice1y ?? null,
      ]);

      // @ts-ignore - mysql2 result type
      if (result[0].affectedRows > 0) {
        logger.info(`Prediction recorded for ${input.symbol}`, {
          symbol: input.symbol,
          predictedAt: new Date().toISOString().split('T')[0],
        });
        return true;
      } else {
        logger.info(`Duplicate prediction (ignored) for ${input.symbol} on same day`, { symbol: input.symbol });
        return false;
      }
    } finally {
      conn.release();
    }
  } catch (error) {
    logger.error('Failed to record prediction', { symbol: input.symbol, error });
    return false;
  }
}
