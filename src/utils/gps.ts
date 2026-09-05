/**
 * GPS (Global Performance Metric) Calculation Utility (v3.0)
 * 8-component, 100-point scoring system.
 * GPS score is the single source of truth for all buy/sell recommendations.
 */
import { HORIZON_ML_PREDICTION_CEILING_PCT, type HorizonKey } from './horizons';

export interface GpsMetrics {
  analystUpside?: number;       // fraction (0.30 = 30% upside), max 12 pts
  revenueGrowthPct?: number;    // fraction, max 12 pts
  earningsGrowthPct?: number;   // fraction, max 12 pts
  technicalScore?: number;      // raw signal total, range -14..+14, max 17 pts
  recommendationKey?: string;   // 'strongBuy' | 'buy' | 'hold' | 'underperform' | 'sell', max 9 pts
  priceChange52w?: number;      // fraction, max 8 pts
}

export interface GpsPredictionResult {
  predictedChangePct1m?: number;  // percentage value (3.5 = 3.5%), max 20 pts
  confidenceScore?: number;       // 0–100, max 5 pts
}

/** Inputs to GPS-Light — the tier-1 score computed before Monte Carlo runs.
 *  Replaces the 30-pt MLP block (mlpUpside + mlpConfidence) with a 25-pt
 *  ranker block and a 5-pt vol-based uncertainty proxy. The other 70 points
 *  (rev/earn/tech/analyst/52w) are identical to GPS-Full. */
export interface GpsLightInput {
  /** Ranker percentile within today's universe, 0..1. Higher = better. */
  rankerScorePct?: number;
  /** Annualized 30-day realized vol (e.g. 0.25 = 25%). Lower → higher
   *  confidence-proxy pts, mirroring how the MLP's confidenceScore behaves. */
  histVol30?: number;
}

export interface GpsBreakdown {
  mlpUpside: number;        // 25 pts — ML predicted change
  mlpConfidence: number;    // 5 pts  — AI model confidence
  revenueGrowth: number;    // 12 pts
  earningsGrowth: number;   // 12 pts
  technicalSignal: number;  // 17 pts — normalized technical score
  analystUpside: number;    // 12 pts
  analystConsensus: number; // 9 pts
  priceChange52w: number;   // 8 pts
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
 * Card-only Buy/Sell label using the variant-B band scheme:
 *
 *   0 – 25    Strong Sell
 *   25 – 45   Sell
 *   45 – 55   Hold    (10-pt narrow neutral zone)
 *   55 – 75   Buy
 *   75 – 100  Strong Buy
 *
 * Used by <GpsCallLabel> on the portfolio, watchlist, and trending card
 * surfaces (and forwarded to GpsBreakdownModal's Rating badge when opened
 * from a portfolio card via GpsTooltip variant="card").
 *
 * IMPORTANT: do NOT use this for the recommendations engine, DeepMoney
 * picks, /search/industry/[sector], the stock detail page's GPS panel, or
 * any backend gating. Those surfaces use the canonical `getGpsLabel` above,
 * which aligns with the env-var thresholds (BUY=65, SELL=45,
 * DEEPMONEY_MIN=65, DISCOVERY=70). Mixing the two functions in those
 * surfaces would silently shift behavior tied to those env vars.
 *
 * Returns '—' for null input so the same call site can render a placeholder
 * when the sector-leader pre-warm sync hasn't covered a stock yet.
 */
export function getCardCallLabel(score: number | null): string {
  if (score === null) return '—'
  if (score >= 75) return 'Strong Buy'
  if (score >= 55) return 'Buy'
  if (score >= 45) return 'Hold'
  if (score >= 25) return 'Sell'
  return 'Strong Sell'
}

/**
 * Tailwind class string for the card Buy/Sell badge — 5-tier color ramp
 * aligned with `getCardCallLabel` thresholds. Mirrors the GPS column style
 * used on /search/industry/[sector]. Null → grey placeholder.
 */
export function getCardBadgeClass(score: number | null): string {
  if (score === null) return 'bg-gray-100 text-gray-400 border-gray-200'
  if (score >= 75) return 'bg-green-100 text-green-800 border-green-300'
  if (score >= 55) return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (score >= 45) return 'bg-yellow-100 text-yellow-800 border-yellow-200'
  if (score >= 25) return 'bg-orange-100 text-orange-800 border-orange-200'
  return 'bg-red-100 text-red-800 border-red-200'
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
  horizon: HorizonKey = '1_month',
): { breakdown: GpsBreakdown; score: number } {
  // See calculateGpsScore's matching comment: the ceiling is anchored to
  // this horizon's own empirical p75 predicted change, not a scaled 1-month
  // value — otherwise a longer-horizon prediction's larger cumulative % move
  // gets judged against a ceiling that doesn't reflect how it actually
  // scores relative to its own horizon's peers.
  const predictionMax = HORIZON_ML_PREDICTION_CEILING_PCT[horizon]
  // Floors at 0 for a negative prediction — see calculateGpsScore's matching
  // comment: any decline gets 0 credit here, same as the other components,
  // rather than scaling further negative the worse the predicted drop is.
  const newMlpUpside = Math.min(Math.max(predictedChangePctForHorizon / predictionMax, 0), 1) * 25
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
 *   - mlpUpside (25 pts)     → rankerScorePct × 25
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
  // 1. Ranker upside (25 pts) — model's percentile rank within today's universe.
  const rankerPct = Math.min(Math.max(light.rankerScorePct ?? 0, 0), 1);
  const m1 = rankerPct * 25;

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
  const m5 = Math.min(Math.max((rawTech + 14) / 28, 0), 1) * 17;
  const m6 = Math.min(Math.max((metrics.analystUpside || 0) / 0.3, 0), 1) * 12;
  const m7 = CONSENSUS_POINTS[metrics.recommendationKey ?? ''] ?? CONSENSUS_POINTS.hold;
  const m8 = Math.min(Math.max((metrics.priceChange52w || 0) / 0.2, 0), 1) * 8;

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

export function calculateGpsScore(
  metrics: GpsMetrics,
  prediction: GpsPredictionResult,
  options: { horizon?: HorizonKey } = {},
): GpsResult {
  // The ML Prediction ceiling is anchored per-horizon to that horizon's own
  // empirical p75 predicted change (HORIZON_ML_PREDICTION_CEILING_PCT) — see
  // its doc comment in horizons.ts. `options.horizon` defaults to 1_month,
  // which is also what every call that scores the persisted baseline uses
  // (they don't pass `options`), so the baseline's ceiling is this table's
  // 1_month value, not a separate env-driven constant.
  const predictionMax = HORIZON_ML_PREDICTION_CEILING_PCT[options.horizon ?? '1_month']

  // 1. ML Predicted Change 1m (25 pts). Floors at 0 for any negative
  // prediction — matching every other component here (revenue/earnings
  // growth, analyst upside), which give 0 credit for a bad signal rather
  // than actively subtracting points that scale with how bad it is. A -5%
  // and a -99% prediction are both "don't buy this"; there's no reason a
  // near-total-wipeout prediction should drag the score lower than a mild
  // dip would. bearishSignal (below) still separately flags any decline.
  const m1 = Math.min(Math.max((prediction.predictedChangePct1m || 0) / predictionMax, 0), 1) * 25

  // 2. AI Model Confidence (5 pts — linear, 100 = 5 pts)
  const m2 = ((prediction.confidenceScore || 0) / 100) * 5

  // 3. Revenue Growth YoY (12 pts — full at 30%)
  const m3 = Math.min(Math.max((metrics.revenueGrowthPct || 0) / 0.3, 0), 1) * 12

  // 4. Earnings Growth YoY (12 pts — full at 25%)
  const m4 = Math.min(Math.max((metrics.earningsGrowthPct || 0) / 0.25, 0), 1) * 12

  // 5. Technical Signal (17 pts — raw -14..+14 mapped linearly to 0..17)
  const rawTech = metrics.technicalScore ?? 0
  const m5 = Math.min(Math.max((rawTech + 14) / 28, 0), 1) * 17

  // 6. Analyst Price Target Upside (12 pts — full at 30%)
  const m6 = Math.min(Math.max((metrics.analystUpside || 0) / 0.3, 0), 1) * 12

  // 7. Analyst Consensus Rating (9 pts)
  const m7 = CONSENSUS_POINTS[metrics.recommendationKey ?? ''] ?? CONSENSUS_POINTS.hold

  // 8. 52-Week Momentum (8 pts — full at 20%)
  const m8 = Math.min(Math.max((metrics.priceChange52w || 0) / 0.2, 0), 1) * 8

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
