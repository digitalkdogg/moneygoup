/**
 * GPS Score Calibration — post-hoc percentile rescaling.
 *
 * Problem: calculateGpsScore() (src/utils/gps.ts) sums 8 independently-capped,
 * absolute-threshold components. Against the real stock universe this produces
 * a raw score distribution clustered well below the nominal 0-100 scale (empirically:
 * mean ~41, only ~0.2% of stocks clearing 80) because several components are
 * calibrated against rare best-case fundamentals (e.g. GPS_PREDICTION_MAX=15
 * requires a predicted +15% one-month move to max the largest single component).
 *
 * Rather than re-tuning those absolute thresholds by hand (which drifts again as
 * the market/universe shifts), this module maps each stock's raw score to a
 * calibrated score based on its percentile rank within the current universe, so a
 * fixed target fraction of stocks lands above a target score by construction.
 *
 * Used by scripts/recalibrate_gps_scores.ts, which runs after the nightly batch
 * scoring jobs (update_predictions.py, deepmoney_sync.py) populate raw scores.
 */

export const DEFAULT_TARGET_PERCENTILE = 0.9;
export const DEFAULT_TARGET_SCORE = 80;

export interface CalibrationOptions {
  /** Percentile rank (0-1) that should land at targetScore. Default 0.9 (top 10%). */
  targetPercentile?: number;
  /** Score (0-100) the targetPercentile rank should map to. Default 80. */
  targetScore?: number;
}

/**
 * Percentile rank of `score` within `sortedRawScores` (must be pre-sorted ascending),
 * using mid-rank (average) tie handling: a value tied with N-1 others sits at the
 * midpoint of the tied block's rank range, not the top or bottom of it.
 * Returns a value in [0, 1]; an empty array returns 0.
 */
export function percentileRank(sortedRawScores: number[], score: number): number {
  const n = sortedRawScores.length;
  if (n === 0) return 0;

  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedRawScores[mid] < score) lo = mid + 1;
    else hi = mid;
  }
  const countBelow = lo;

  lo = 0;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedRawScores[mid] <= score) lo = mid + 1;
    else hi = mid;
  }
  const countAtOrBelow = lo;
  const countEqual = countAtOrBelow - countBelow;

  return (countBelow + countEqual / 2) / n;
}

/**
 * Maps a percentile rank (0-1) to a calibrated 0-100 score via a power curve
 * `100 * percentile^exponent`, where `exponent` is solved so that
 * `targetPercentile` maps exactly to `targetScore`. Monotonic increasing,
 * f(0) = 0, f(1) = 100.
 */
export function calibrateFromPercentile(percentile: number, options: CalibrationOptions = {}): number {
  const targetPercentile = options.targetPercentile ?? DEFAULT_TARGET_PERCENTILE;
  const targetScore = options.targetScore ?? DEFAULT_TARGET_SCORE;

  if (targetPercentile <= 0 || targetPercentile >= 1) {
    throw new Error('targetPercentile must be strictly between 0 and 1');
  }
  if (targetScore <= 0 || targetScore >= 100) {
    throw new Error('targetScore must be strictly between 0 and 100');
  }

  const p = Math.min(Math.max(percentile, 0), 1);
  if (p === 0) return 0;

  const exponent = Math.log(targetScore / 100) / Math.log(targetPercentile);
  const calibrated = 100 * Math.pow(p, exponent);
  return Math.min(Math.max(calibrated, 0), 100);
}
