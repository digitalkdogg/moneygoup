/**
 * GPS (Global Performance Metric) Calculation Utility (v3.0)
 * 8-component, 100-point scoring system.
 * GPS score is the single source of truth for all buy/sell recommendations.
 */

export interface GpsMetrics {
  analystUpside?: number;       // fraction (0.30 = 30% upside), max 12 pts
  revenueGrowthPct?: number;    // fraction, max 12 pts
  earningsGrowthPct?: number;   // fraction, max 12 pts
  technicalScore?: number;      // raw signal total, range -14..+14, max 20 pts
  recommendationKey?: string;   // 'strongBuy' | 'buy' | 'hold' | 'underperform' | 'sell', max 9 pts
  priceChange52w?: number;      // fraction, max 10 pts
}

export interface GpsPredictionResult {
  predictedChangePct1m?: number;  // percentage value (3.5 = 3.5%), max 20 pts
  confidenceScore?: number;       // 0–100, max 5 pts
}

/** Inputs to GPS-Light — the tier-1 score computed before Monte Carlo runs.
 *  Replaces the 25-pt MLP block (mlpUpside + mlpConfidence) with a 20-pt
 *  ranker block and a 5-pt vol-based uncertainty proxy. The other 75 points
 *  (rev/earn/tech/analyst/52w) are identical to GPS-Full. */
export interface GpsLightInput {
  /** Ranker percentile within today's universe, 0..1. Higher = better. */
  rankerScorePct?: number;
  /** Annualized 30-day realized vol (e.g. 0.25 = 25%). Lower → higher
   *  confidence-proxy pts, mirroring how the MLP's confidenceScore behaves. */
  histVol30?: number;
}

export interface GpsBreakdown {
  mlpUpside: number;        // 20 pts — ML predicted change
  mlpConfidence: number;    // 5 pts  — AI model confidence
  revenueGrowth: number;    // 12 pts
  earningsGrowth: number;   // 12 pts
  technicalSignal: number;  // 20 pts — normalized technical score
  analystUpside: number;    // 12 pts
  analystConsensus: number; // 9 pts
  priceChange52w: number;   // 10 pts
}

export interface GpsResult {
  score: number;
  breakdown: GpsBreakdown;
  bearishSignal: boolean;
}

const CONSENSUS_POINTS: Record<string, number> = {
  strongBuy:    9,
  strong_buy:   9,
  buy:          7,
  hold:         4,
  underperform: 2,
  sell:         0,
}

export function getGpsLabel(score: number): string {
  if (score >= 80) return 'Strong Buy'
  if (score >= 65) return 'Buy'
  if (score >= 45) return 'Hold'
  if (score >= 30) return 'Sell'
  return 'Strong Sell'
}

/**
 * Patch the two horizon-dependent components (`mlpUpside`, `mlpConfidence`) of
 * a cached breakdown using the model's own per-horizon outputs. The other 6
 * components (revenue, earnings, technical, analyst signals, 52w momentum) are
 * horizon-independent and pass through unchanged. Pass `confidenceScoreForHorizon`
 * as undefined to leave mlpConfidence at the baseline value (back-compat with
 * rows persisted before per-horizon confidence was captured).
 *
 * Match guarantee: when called with the same values calculateGpsScore receives,
 * the resulting score exactly matches a full recompute — because the 6 other
 * components are identical regardless of horizon.
 */
export function adjustGpsForHorizon(
  breakdown: GpsBreakdown,
  predictedChangePctForHorizon: number,
  confidenceScoreForHorizon?: number,
): { breakdown: GpsBreakdown; score: number } {
  const predictionMax = process.env.GPS_PREDICTION_MAX ? parseFloat(process.env.GPS_PREDICTION_MAX) : 3
  const newMlpUpside = Math.min(Math.max(predictedChangePctForHorizon / predictionMax, -1), 1) * 20
  const newMlpConfidence = confidenceScoreForHorizon != null
    ? (Math.min(Math.max(confidenceScoreForHorizon, 0), 100) / 100) * 5
    : breakdown.mlpConfidence

  const adjusted: GpsBreakdown = {
    ...breakdown,
    mlpUpside: parseFloat(newMlpUpside.toFixed(1)),
    mlpConfidence: parseFloat(newMlpConfidence.toFixed(1)),
  }
  const total =
    adjusted.mlpUpside + adjusted.mlpConfidence + adjusted.revenueGrowth +
    adjusted.earningsGrowth + adjusted.technicalSignal + adjusted.analystUpside +
    adjusted.analystConsensus + adjusted.priceChange52w

  return {
    breakdown: adjusted,
    score: parseFloat(Math.min(Math.max(total, 0), 100).toFixed(1)),
  }
}

/**
 * GPS-Light — the tier-1 composite computed *before* Monte Carlo runs.
 *
 * Structurally identical to calculateGpsScore (same 8-component, 100-pt
 * breakdown) except the top-25 MLP block is replaced:
 *   - mlpUpside (20 pts)     → rankerScorePct × 20
 *   - mlpConfidence (5 pts)  → low-vol proxy: 5 × (1 - HistVol_30 / volCeiling)
 *
 * Components 3-8 (revenue, earnings, technical, analyst×2, 52w) are unchanged
 * — exactly the same code path as the full GPS score. This keeps the two
 * scores on the same 0-100 scale so a watchlist-tier 'light' row and a
 * surfaced-tier 'full' row are directly comparable.
 *
 * The breakdown's `mlpUpside` and `mlpConfidence` fields are reused (not
 * renamed) so existing UI consumers don't break. The caller stores
 * gps_score_type='light' alongside the score to disambiguate semantics.
 */
export function calculateGpsLight(metrics: GpsMetrics, light: GpsLightInput): GpsResult {
  // 1. Ranker upside (20 pts) — model's percentile rank within today's universe.
  const rankerPct = Math.min(Math.max(light.rankerScorePct ?? 0, 0), 1);
  const m1 = rankerPct * 20;

  // 2. Volatility-based confidence proxy (5 pts).
  // Low realized vol = high "confidence" that the cheap signals are stable.
  // Default ceiling 0.80 — typical equity 30-day annualized vol caps here.
  const volCeiling = process.env.GPS_LIGHT_VOL_CEILING
    ? parseFloat(process.env.GPS_LIGHT_VOL_CEILING)
    : 0.80;
  const hv = light.histVol30 ?? 0.30;  // 30% is a reasonable equity median
  const m2 = Math.max(0, Math.min(5, 5 * (1 - hv / volCeiling)));

  // 3-8. Cheap signals — identical formulas to calculateGpsScore (m3..m8).
  const m3 = Math.min(Math.max((metrics.revenueGrowthPct || 0) / 0.3, 0), 1) * 12;
  const m4 = Math.min(Math.max((metrics.earningsGrowthPct || 0) / 0.25, 0), 1) * 12;
  const rawTech = metrics.technicalScore ?? 0;
  const m5 = Math.min(Math.max((rawTech + 14) / 28, 0), 1) * 20;
  const m6 = Math.min(Math.max((metrics.analystUpside || 0) / 0.3, 0), 1) * 12;
  const m7 = CONSENSUS_POINTS[metrics.recommendationKey ?? ''] ?? CONSENSUS_POINTS.hold;
  const m8 = Math.min(Math.max((metrics.priceChange52w || 0) / 0.2, 0), 1) * 10;

  const totalGps = m1 + m2 + m3 + m4 + m5 + m6 + m7 + m8;

  return {
    score: parseFloat(Math.min(Math.max(totalGps, 0), 100).toFixed(1)),
    // GPS-Light has no Monte Carlo prediction → no bearish signal flag.
    bearishSignal: false,
    breakdown: {
      mlpUpside:        parseFloat(m1.toFixed(1)),
      mlpConfidence:    parseFloat(m2.toFixed(1)),
      revenueGrowth:    parseFloat(m3.toFixed(1)),
      earningsGrowth:   parseFloat(m4.toFixed(1)),
      technicalSignal:  parseFloat(m5.toFixed(1)),
      analystUpside:    parseFloat(m6.toFixed(1)),
      analystConsensus: parseFloat(m7.toFixed(1)),
      priceChange52w:   parseFloat(m8.toFixed(1)),
    },
  };
}

export function calculateGpsScore(metrics: GpsMetrics, prediction: GpsPredictionResult): GpsResult {
  const predictionMax = process.env.GPS_PREDICTION_MAX ? parseFloat(process.env.GPS_PREDICTION_MAX) : 3

  // 1. ML Predicted Change 1m (20 pts)
  const m1 = Math.min(Math.max((prediction.predictedChangePct1m || 0) / predictionMax, -1), 1) * 20

  // 2. AI Model Confidence (5 pts — linear, 100 = 5 pts)
  const m2 = ((prediction.confidenceScore || 0) / 100) * 5

  // 3. Revenue Growth YoY (12 pts — full at 30%)
  const m3 = Math.min(Math.max((metrics.revenueGrowthPct || 0) / 0.3, 0), 1) * 12

  // 4. Earnings Growth YoY (12 pts — full at 25%)
  const m4 = Math.min(Math.max((metrics.earningsGrowthPct || 0) / 0.25, 0), 1) * 12

  // 5. Technical Signal (20 pts — raw -14..+14 mapped linearly to 0..20)
  const rawTech = metrics.technicalScore ?? 0
  const m5 = Math.min(Math.max((rawTech + 14) / 28, 0), 1) * 20

  // 6. Analyst Price Target Upside (12 pts — full at 30%)
  const m6 = Math.min(Math.max((metrics.analystUpside || 0) / 0.3, 0), 1) * 12

  // 7. Analyst Consensus Rating (9 pts)
  const m7 = CONSENSUS_POINTS[metrics.recommendationKey ?? ''] ?? CONSENSUS_POINTS.hold

  // 8. 52-Week Momentum (10 pts — full at 20%)
  const m8 = Math.min(Math.max((metrics.priceChange52w || 0) / 0.2, 0), 1) * 10

  const totalGps = m1 + m2 + m3 + m4 + m5 + m6 + m7 + m8

  return {
    score: parseFloat(Math.min(Math.max(totalGps, 0), 100).toFixed(1)),
    bearishSignal: (prediction.predictedChangePct1m || 0) < 0,
    breakdown: {
      mlpUpside:        parseFloat(m1.toFixed(1)),
      mlpConfidence:    parseFloat(m2.toFixed(1)),
      revenueGrowth:    parseFloat(m3.toFixed(1)),
      earningsGrowth:   parseFloat(m4.toFixed(1)),
      technicalSignal:  parseFloat(m5.toFixed(1)),
      analystUpside:    parseFloat(m6.toFixed(1)),
      analystConsensus: parseFloat(m7.toFixed(1)),
      priceChange52w:   parseFloat(m8.toFixed(1)),
    },
  }
}
