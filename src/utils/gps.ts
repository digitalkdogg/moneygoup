/**
 * GPS (Global Performance Metric) Calculation Utility (v2.4)
 * Combines traditional fundamentals with DeepMoney forecasts.
 * v2.4: Bearish ML predictions now apply a negative penalty to the GPS score.
 */

export interface GpsMetrics {
  analystUpside?: number;
  revenueGrowth?: number;
  earningsGrowth?: number;
  fiftyTwoWeekChange?: number;
}

export interface GpsPredictionResult {
  predicted_change_pct?: number;
  confidence_score?: number;
}

export interface GpsBreakdown {
  analystUpside: number;
  revenueGrowth: number;
  earningsGrowth: number;
  fiftyTwoWeekChange: number;
  mlpUpside: number;
  mlpConfidence: number;
}

export interface GpsResult {
  score: number;
  breakdown: GpsBreakdown;
  bearishSignal: boolean;
}

/**
 * Calculates the GPS score (0-100) based on fundamentals and ML prediction.
 */
export function calculateGpsScore(metrics: GpsMetrics, prediction: GpsPredictionResult): GpsResult {
  const analystUpside = metrics.analystUpside || 0;
  const revenueGrowth = metrics.revenueGrowth || 0;
  const earningsGrowth = metrics.earningsGrowth || 0;
  const fiftyTwoWeekChange = metrics.fiftyTwoWeekChange || 0;

  // 1. Analyst Upside (19 pts)
  // Scaling: 30% upside = 19 pts
  const m1 = Math.min(Math.max(analystUpside / 0.3, 0), 1) * 19;

  // 2. Revenue Growth (19 pts)
  // Scaling: 30% growth = 19 pts
  const m2 = Math.min(Math.max(revenueGrowth / 0.3, 0), 1) * 19;

  // 3. Earnings Growth (19 pts)
  // Scaling: 25% growth = 19 pts
  const m3 = Math.min(Math.max(earningsGrowth / 0.25, 0), 1) * 19;

  // 4. 52-Week Price Change (19 pts)
  // Scaling: 20% growth = 19 pts
  const m4 = Math.min(Math.max(fiftyTwoWeekChange / 0.2, 0), 1) * 19;

  // 5a. MLP Predicted Upside (19 pts)
  // Scaling: [GPS_PREDICTION_MAX]% predicted change = 19 pts (very strong for 1-month outlook)
  const predictionMax = process.env.GPS_PREDICTION_MAX ? parseFloat(process.env.GPS_PREDICTION_MAX) : 3;
  const m5a = Math.min(Math.max((prediction.predicted_change_pct || 0) / predictionMax, -1), 1) * 19;

  // 5b. MLP Confidence Score (5 pts)
  // Scaling: 100 confidence = 5 pts
  const m5b = ((prediction.confidence_score || 0) / 100) * 5;

  const totalGps = m1 + m2 + m3 + m4 + m5a + m5b;

  return {
    score: parseFloat(Math.min(totalGps, 100).toFixed(1)),
    bearishSignal: (prediction.predicted_change_pct || 0) < 0,
    breakdown: {
      analystUpside: parseFloat(m1.toFixed(1)),
      revenueGrowth: parseFloat(m2.toFixed(1)),
      earningsGrowth: parseFloat(m3.toFixed(1)),
      fiftyTwoWeekChange: parseFloat(m4.toFixed(1)),
      mlpUpside: parseFloat(m5a.toFixed(1)),
      mlpConfidence: parseFloat(m5b.toFixed(1))
    }
  };
}