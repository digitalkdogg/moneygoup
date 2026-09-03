/**
 * Nightly post-processing step: rescales every stock's raw GPS score to a
 * percentile-calibrated score against the current universe, so a fixed target
 * fraction of stocks lands above a target score (default: top 10% score 80+).
 *
 * Why this exists: calculateGpsScore() (src/utils/gps.ts) sums 8 absolute-
 * threshold components. Empirically that produces a raw distribution clustered
 * well below 80 for nearly the whole universe (mean ~41, <1% above 80 as of
 * 2026-09), because several components are calibrated against rare best-case
 * fundamentals. Re-tuning those absolute thresholds by hand drifts again as the
 * market/universe shifts; percentile calibration self-adjusts every run.
 *
 * Idempotent: the first calibrated component ever computed for a stock is
 * cached in gps_breakdown.rawScore and always used as the calibration input on
 * later runs, so re-running this script (or running it twice in one night)
 * never calibrates an already-calibrated score.
 *
 * Run nightly, AFTER update_predictions.py and deepmoney_sync.py have finished
 * writing raw scores:
 *   node --env-file=.env --import jiti/register scripts/recalibrate_gps_scores.ts
 *
 * Env vars (both optional):
 *   GPS_CALIBRATION_TARGET_PERCENTILE  default 0.9   (top fraction, e.g. 0.9 = top 10%)
 *   GPS_CALIBRATION_TARGET_SCORE       default 80    (score that percentile should hit)
 */
import { getDbConnection, closeDbPool } from '../src/utils/db';
import { percentileRank, calibrateFromPercentile } from '../src/utils/gpsCalibration';

interface GpsRow {
  stock_id: number;
  ticker: string;
  gps_score: string;
  gps_breakdown: Record<string, unknown> | string | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function parseBreakdown(value: GpsRow['gps_breakdown']): Record<string, unknown> {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function main() {
  const targetPercentile = process.env.GPS_CALIBRATION_TARGET_PERCENTILE
    ? parseFloat(process.env.GPS_CALIBRATION_TARGET_PERCENTILE)
    : undefined;
  const targetScore = process.env.GPS_CALIBRATION_TARGET_SCORE
    ? parseFloat(process.env.GPS_CALIBRATION_TARGET_SCORE)
    : undefined;

  const pool = await getDbConnection();
  try {
    const [rows] = await pool.query(
      `SELECT sgs.stock_id, s.symbol AS ticker, sgs.gps_score, sgs.gps_breakdown
       FROM stock_gps_scores sgs
       JOIN stocks s ON s.id = sgs.stock_id`,
    ) as unknown as [GpsRow[], unknown];

    if (rows.length === 0) {
      console.log('No rows in stock_gps_scores — nothing to calibrate.');
      return;
    }

    const breakdowns = rows.map(r => parseBreakdown(r.gps_breakdown));

    // Raw score = cached breakdown.rawScore from a prior calibration run, else
    // the current gps_score (first run — assumed not yet calibrated).
    const rawScores = rows.map((r, i) => {
      const cached = breakdowns[i].rawScore;
      return typeof cached === 'number' ? cached : parseFloat(r.gps_score);
    });
    const sortedRaw = [...rawScores].sort((a, b) => a - b);

    let updated = 0;
    let unchanged = 0;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawScore = rawScores[i];
      const percentile = percentileRank(sortedRaw, rawScore);
      const calibrated = round1(calibrateFromPercentile(percentile, { targetPercentile, targetScore }));

      const existingScore = parseFloat(row.gps_score);
      const changed = Math.round(existingScore * 10) !== Math.round(calibrated * 10);

      const newBreakdown = {
        ...breakdowns[i],
        rawScore,
        calibrationPercentile: Math.round(percentile * 1000) / 1000,
      };

      if (!changed) {
        // Still persist rawScore/percentile the first time even if the score
        // itself didn't move (e.g. targetPercentile ~= median already).
        if (breakdowns[i].rawScore === undefined) {
          await pool.query(
            `UPDATE stock_gps_scores SET gps_breakdown = ? WHERE stock_id = ?`,
            [JSON.stringify(newBreakdown), row.stock_id],
          );
        }
        unchanged++;
        continue;
      }

      await pool.query(
        `UPDATE stock_gps_scores SET gps_score = ?, gps_breakdown = ?, as_of = ? WHERE stock_id = ?`,
        [calibrated, JSON.stringify(newBreakdown), now, row.stock_id],
      );

      await pool.query(
        `INSERT IGNORE INTO stock_gps_score_history (stock_id, as_of, gps_score, gps_breakdown, model_version, regime, source)
         VALUES (?, ?, ?, ?, NULL, NULL, 'gps_calibration')`,
        [row.stock_id, now, calibrated, JSON.stringify(newBreakdown)],
      );

      // Best-effort sync to the latest recommended_stocks snapshot (no-op if absent).
      await pool.query(
        `UPDATE recommended_stocks r
         INNER JOIN (
           SELECT MAX(snapshot_date) AS max_date FROM recommended_stocks WHERE ticker = ?
         ) latest ON r.snapshot_date = latest.max_date
         SET r.gps_score = ?, r.gps_breakdown = ?
         WHERE r.ticker = ?`,
        [row.ticker, calibrated, JSON.stringify(newBreakdown), row.ticker],
      );

      updated++;
    }

    console.log(`Calibrated ${rows.length} stocks: ${updated} score(s) changed, ${unchanged} unchanged.`);
    console.log(`Target: ${(targetPercentile ?? 0.9) * 100}th percentile -> score ${targetScore ?? 80}.`);
  } finally {
    await closeDbPool();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
