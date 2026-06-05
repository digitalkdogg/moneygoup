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
