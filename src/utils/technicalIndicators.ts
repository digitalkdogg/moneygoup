import { calculateAnnualizedVolatility, getVolatilityRating } from './volatility';

export interface HistoricalData {
  date?: string
  datetime?: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface ScoreBreakdown {
  maScore: number
  maReason: string
  rsiScore: number
  rsiReason: string
  momentumScore: number
  momentumReason: string
  priceScore: number
  priceReason: string
  volatilityScore: number;
  volatilityReason: string;
  newsScore: number;
  newsReason: string;
  peRatioScore: number;
  peRatioReason: string;
  pbRatioScore: number;
  pbRatioReason: string;
  marketCapScore: number;
  marketCapReason: string;
  coreMetricsScore: number;
  coreMetricsReason: string;
  totalScore: number
}

export interface TechnicalIndicators {
  sma20: number | null
  sma50: number | null
  rsi14: number | null
  momentum: number | null
  signal: 'BUY' | 'SELL' | 'HOLD'
  signalStrength: number
  signalReason: string
  scoreBreakdown: ScoreBreakdown
  volatility: "Low" | "Medium" | "High" | "N/A" | null;
}

export interface IndicatorSnapshot {
  date: string
  close: number
  sma20: number | null
  sma50: number | null
  rsi14: number | null
}

/**
 * Calculate Simple Moving Average (SMA)
 * @param prices Array of prices
 * @param period Number of periods for the moving average
 * @returns Latest SMA value or null if insufficient data
 */
function calculateSMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null
  const recent = prices.slice(-period)
  return recent.reduce((sum, price) => sum + price, 0) / period
}

/**
 * Calculate Relative Strength Index (RSI)
 * @param prices Array of prices
 * @param period Period for RSI calculation (default 14)
 * @returns RSI value between 0-100 or null if insufficient data
 */
function calculateRSI(prices: number[], period: number = 14): number | null {
  if (prices.length < period + 1) return null

  const changes = []
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1])
  }

  const gains = changes.map(c => (c > 0 ? c : 0))
  const losses = changes.map(c => (c < 0 ? -c : 0))

  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  const rsi = 100 - 100 / (1 + rs)

  return Math.round(rsi * 100) / 100
}

/**
 * Calculate Momentum
 * Momentum = Current Price - Price n periods ago
 * Positive momentum = uptrend, Negative = downtrend
 */
function calculateMomentum(prices: number[], period: number = 10): number | null {
  if (prices.length < period + 1) return null
  const current = prices[prices.length - 1]
  const previous = prices[prices.length - 1 - period]
  return Math.round((current - previous) * 100) / 100
}

/**
 * Generate trading signal based on multiple indicators
 * Uses a scoring system combining MA crossover, RSI, and momentum
 * Returns detailed breakdown of how each metric contributes to the signal
 */
function generateSignal(
  sma20: number | null,
  sma50: number | null,
  rsi: number | null,
  momentum: number | null,
  currentPrice: number,
  volatilityRating: "Low" | "Medium" | "High" | "N/A" | null,
  newsSentiment: number | null,
  peRatio: number | null | undefined,
  pbRatio: number | null | undefined,
  marketCap: number | null | undefined
): { signal: 'BUY' | 'SELL' | 'HOLD'; strength: number; reason: string; breakdown: ScoreBreakdown } {
  const reasons: string[] = []

  // ============ MA Crossover Strategy (weight: 3) ============
  let maScore = 0
  let maReason = ''
  if (sma20 !== null && sma50 !== null) {
    if (sma20 > sma50) {
      maScore = 3
      maReason = `Bullish (SMA20: ${sma20.toFixed(2)} > SMA50: ${sma50.toFixed(2)})`
      reasons.push('Bullish MA crossover')
    } else if (sma20 < sma50) {
      maScore = -3
      maReason = `Bearish (SMA20: ${sma20.toFixed(2)} < SMA50: ${sma50.toFixed(2)})`
      reasons.push('Bearish MA crossover')
    } else {
      maScore = 0
      maReason = 'Neutral (SMA20 ≈ SMA50)'
    }
  } else {
    maScore = 0
    maReason = 'Insufficient data'
  }

  // ============ RSI Strategy (weight: 2) ============
  let rsiScore = 0
  let rsiReason = ''
  if (rsi !== null) {
    if (rsi < 30) {
      rsiScore = 2
      rsiReason = `Oversold (RSI: ${rsi.toFixed(2)} < 30) - Buying opportunity`
      reasons.push('RSI Oversold (<30)')
    } else if (rsi > 70) {
      rsiScore = -2
      rsiReason = `Overbought (RSI: ${rsi.toFixed(2)} > 70) - Selling pressure`
      reasons.push('RSI Overbought (>70)')
    } else {
      rsiScore = 0
      rsiReason = `Neutral (RSI: ${rsi.toFixed(2)} in 30-70 range)`
      if (rsi > 40 && rsi < 60) {
        reasons.push('RSI Neutral (40-60)')
      }
    }
  } else {
    rsiScore = 0
    rsiReason = 'Insufficient data'
  }

  // ============ Momentum Strategy (weight: 2) ============
  let momentumScore = 0
  let momentumReason = ''
  if (momentum !== null) {
    if (momentum > 0) {
      momentumScore = 2
      momentumReason = `Bullish (Momentum: ${momentum.toFixed(2)} > 0)`
      reasons.push('Positive momentum')
    } else if (momentum < 0) {
      momentumScore = -2
      momentumReason = `Bearish (Momentum: ${momentum.toFixed(2)} < 0)`
      reasons.push('Negative momentum')
    } else {
      momentumScore = 0
      momentumReason = `Neutral (Momentum: ${momentum.toFixed(2)} ≈ 0)`
    }
  } else {
    momentumScore = 0
    momentumReason = 'Insufficient data'
  }

  // ============ Price vs MA Strategy (weight: 1) ============
  let priceScore = 0
  let priceReason = ''
  if (sma50 !== null) {
    if (currentPrice > sma50) {
      priceScore = 1
      priceReason = `Above (Price: ${currentPrice.toFixed(2)} > SMA50: ${sma50.toFixed(2)})`
      reasons.push('Price above 50-day MA')
    } else if (currentPrice < sma50) {
      priceScore = -1
      priceReason = `Below (Price: ${currentPrice.toFixed(2)} < SMA50: ${sma50.toFixed(2)})`
      reasons.push('Price below 50-day MA')
    } else {
      priceScore = 0
      priceReason = `At MA50 (Price ≈ SMA50)`
    }
  } else {
    priceScore = 0
    priceReason = 'Insufficient data'
  }
  
  // ============ Volatility Strategy (weight: 1) ============
  let volatilityScore = 0;
  let volatilityReason = '';
  if (volatilityRating) {
      if (volatilityRating === 'High') {
          volatilityScore = -1;
          volatilityReason = 'High Volatility (Increased Risk)';
          reasons.push('High Volatility');
      } else if (volatilityRating === 'Low') {
          volatilityScore = 1;
          volatilityReason = 'Low Volatility (Increased Stability)';
          reasons.push('Low Volatility');
      } else {
          volatilityReason = 'Medium Volatility (Neutral Risk)';
      }
  } else {
      volatilityReason = 'Insufficient data';
  }

  // ============ News Sentiment Strategy (weight: 2) ============
  let newsScore = 0;
  let newsReason = '';
  if (newsSentiment !== null) {
    if (newsSentiment > 0) { // Adjusted from > 1
      newsScore = 2;
      newsReason = `Positive News Sentiment (Score: ${newsSentiment.toFixed(2)})`;
      reasons.push('Positive News');
    } else if (newsSentiment < 0) { // Adjusted from < -1
      newsScore = -2;
      newsReason = `Negative News Sentiment (Score: ${newsSentiment.toFixed(2)})`;
      reasons.push('Negative News');
    } else {
      newsScore = 0;
      newsReason = `Neutral News Sentiment (Score: ${newsSentiment.toFixed(2)})`;
    }
  } else {
    newsScore = 0;
    newsReason = 'No news data';
  }

  // ============ PE Ratio Strategy (weight: 1) ============
  let peRatioScore = 0;
  let peRatioReason = '';
  if (peRatio !== null && peRatio !== undefined && peRatio > 0) {
    if (peRatio < 15) { // Arbitrary: Low PE is often good
      peRatioScore = 1;
      peRatioReason = `Attractive PE Ratio (${peRatio.toFixed(2)})`;
    } else if (peRatio > 25) { // Arbitrary: High PE might indicate overvaluation
      peRatioScore = -1;
      peRatioReason = `High PE Ratio (${peRatio.toFixed(2)})`;
    } else {
      peRatioReason = `Neutral PE Ratio (${peRatio.toFixed(2)})`;
    }
  } else {
    peRatioReason = 'No PE Ratio data';
  }

  // ============ PB Ratio Strategy (weight: 1) ============
  let pbRatioScore = 0;
  let pbRatioReason = '';
  if (pbRatio !== null && pbRatio !== undefined && pbRatio > 0) {
    if (pbRatio < 2) { // Arbitrary: Low PB is often good
      pbRatioScore = 1;
      pbRatioReason = `Attractive PB Ratio (${pbRatio.toFixed(2)})`;
    } else if (pbRatio > 5) { // Arbitrary: High PB might indicate overvaluation
      pbRatioScore = -1;
      pbRatioReason = `High PB Ratio (${pbRatio.toFixed(2)})`;
    } else {
      pbRatioReason = `Neutral PB Ratio (${pbRatio.toFixed(2)})`;
    }
  } else {
    pbRatioReason = 'No PB Ratio data';
  }

  // ============ Market Cap Strategy (weight: 1) ============
  let marketCapScore = 0;
  let marketCapReason = '';
  if (marketCap !== null && marketCap !== undefined && marketCap > 0) {
    if (marketCap > 200_000_000_000) { // Large Cap (>$200B) - stability
      marketCapScore = 1;
      marketCapReason = `Large Market Cap ($${(marketCap / 1_000_000_000).toFixed(2)}B)`;
    } else if (marketCap < 2_000_000_000) { // Small Cap (<$2B) - higher risk/growth
      marketCapScore = -1; // Can be seen as higher risk
      marketCapReason = `Small Market Cap ($${(marketCap / 1_000_000_000).toFixed(2)}B)`;
    } else {
      marketCapReason = `Mid Market Cap ($${(marketCap / 1_000_000_000).toFixed(2)}B)`;
    }
  } else {
    marketCapReason = 'No Market Cap data';
  }

  // Consolidate Core Metrics Score and Reason
  const coreMetricsScore = peRatioScore + pbRatioScore + marketCapScore;
  let coreMetricsReasonText = 'No core metrics data'; // Initialize with a default

  // Determine the preliminary signal to use in coreMetricsReason
  // This is a simplified version of the final signal determination but useful for context
  const tempSumForPreliminarySignal = maScore + rsiScore + momentumScore + priceScore + volatilityScore + newsScore;

  let preliminarySignal = 'HOLD';
  if (tempSumForPreliminarySignal + coreMetricsScore >= 4) {
    preliminarySignal = 'BUY';
  } else if (tempSumForPreliminarySignal + coreMetricsScore <= -4) {
    preliminarySignal = 'SELL';
  }

  // Construct the coreMetricsReason based on preliminary signal and PE Ratio
  if (peRatio !== undefined && peRatio > 0) {
    if (preliminarySignal === 'BUY') {
      if (peRatio < 20) { // Reasonable P/E threshold for a BUY signal
        coreMetricsReasonText = `Bullish trend + reasonable P/E (${peRatio.toFixed(2)}) → BUY`;
      } else { // High P/E for a BUY signal
        coreMetricsReasonText = `Bullish trend + very high P/E (${peRatio.toFixed(2)}) → BUY (lower confidence)`;
      }
    } else if (preliminarySignal === 'SELL') {
      if (peRatio > 20) { // High P/E for a SELL signal
        coreMetricsReasonText = `Bearish trend + high P/E (${peRatio.toFixed(2)}) → SELL / AVOID`;
      } else { // Low P/E for a SELL signal
        coreMetricsReasonText = `Bearish trend + low P/E (${peRatio.toFixed(2)}) → HOLD / WATCH`;
      }
    } else { // HOLD signal or neutral overall trend
      if (peRatio < 15) { // Low P/E for a HOLD signal
        coreMetricsReasonText = `Neutral trend + low P/E (${peRatio.toFixed(2)}) → HOLD / WATCH`;
      } else if (peRatio > 25) { // High P/E for a HOLD signal
        coreMetricsReasonText = `Neutral trend + high P/E (${peRatio.toFixed(2)}) → HOLD / CAUTION`;
      } else {
        coreMetricsReasonText = `Neutral trend + neutral P/E (${peRatio.toFixed(2)})`;
      }
    }
  } else {
    coreMetricsReasonText = `Overall trend: ${preliminarySignal} (No P/E data available)`;
  }
  
  // Determine the final signal based on the calculated totalScore
  const calculatedTotalScore = maScore + rsiScore + momentumScore + priceScore + volatilityScore + newsScore + coreMetricsScore;

  let signal: 'BUY' | 'SELL' | 'HOLD'
  if (calculatedTotalScore >= 5) {
    signal = 'BUY'
  } else if (calculatedTotalScore <= -5) {
    signal = 'SELL'
  } else {
    signal = 'HOLD'
  }

  // Construct the "AI Summary" signalReason
  const summaryParts: string[] = [];

  // Start with overall sentiment based on the signal itself
  if (signal === 'BUY') {
    summaryParts.push('The overall sentiment is bullish, driven by several positive indicators.');
  } else if (signal === 'SELL') {
    summaryParts.push('The overall sentiment is bearish, primarily due to various negative factors.');
  } else {
    summaryParts.push('The market shows a neutral outlook, with mixed signals from key indicators.');
  }

  // Group and summarize reasons
  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];
  const neutralFactors: string[] = [];

  if (maScore > 0) positiveFactors.push('MA crossover');
  else if (maScore < 0) negativeFactors.push('MA crossover');
  else if (maReason.includes('neutral')) neutralFactors.push('MA crossover');

  if (rsiScore > 0) positiveFactors.push('RSI');
  else if (rsiScore < 0) negativeFactors.push('RSI');
  else if (rsiReason.includes('neutral')) neutralFactors.push('RSI');

  if (momentumScore > 0) positiveFactors.push('momentum');
  else if (momentumScore < 0) negativeFactors.push('momentum');
  else if (momentumReason.includes('neutral')) neutralFactors.push('momentum');

  if (priceScore > 0) positiveFactors.push('price vs SMA(50)');
  else if (priceScore < 0) negativeFactors.push('price vs SMA(50)');
  else if (priceReason.includes('at the')) neutralFactors.push('price vs SMA(50)');

  if (volatilityScore > 0) positiveFactors.push('low volatility');
  else if (volatilityScore < 0) negativeFactors.push('high volatility');
  else if (volatilityReason.includes('Medium')) neutralFactors.push('medium volatility');

  if (newsScore > 0) positiveFactors.push('positive news sentiment');
  else if (newsScore < 0) negativeFactors.push('negative news sentiment');
  else if (newsReason.includes('neutral')) neutralFactors.push('neutral news sentiment');

  if (coreMetricsScore > 0) positiveFactors.push('favorable core metrics');
  else if (coreMetricsScore < 0) negativeFactors.push('unfavorable core metrics');
  else if (coreMetricsReasonText.includes('Neutral')) neutralFactors.push('neutral core metrics');


  if (positiveFactors.length > 0) {
    summaryParts.push(`Key positive factors include ${positiveFactors.join(', ')}.`);
  }
  if (negativeFactors.length > 0) {
    summaryParts.push(`Conversely, concerns arise from ${negativeFactors.join(', ')}.`);
  }
  if (neutralFactors.length > 0 && positiveFactors.length === 0 && negativeFactors.length === 0) {
    summaryParts.push(`Several indicators, such as ${neutralFactors.join(', ')}, remain neutral.`);
  }

  // Add a concluding statement about the core metrics reason
  if (coreMetricsReasonText !== 'No core metrics data' && coreMetricsReasonText !== preliminarySignal + " (No P/E data available)") {
    summaryParts.push(`Valuation insights: ${coreMetricsReasonText.replace('→', 'indicating a').replace('BUY (lower confidence)', 'a potential buy with lower confidence').replace('HOLD / WATCH', 'a hold or watch strategy').replace('SELL / AVOID', 'a sell or avoid strategy').replace('HOLD / CAUTION', 'a hold or caution strategy')}`);
  }

  const finalSignalReason = summaryParts.join(' ');


  // Calculate signal strength (0-100)
  const strength = Math.min(100, Math.abs(calculatedTotalScore) * 10)

  const breakdown: ScoreBreakdown = {
    maScore,
    maReason,
    rsiScore,
    rsiReason,
    momentumScore,
    momentumReason,
    priceScore,
    priceReason,
    volatilityScore,
    volatilityReason,
    newsScore,
    newsReason,
    peRatioScore,
    peRatioReason,
    pbRatioScore,
    pbRatioReason,
    marketCapScore,
    marketCapReason,
    coreMetricsScore,
    coreMetricsReason: coreMetricsReasonText,
    totalScore: calculatedTotalScore
  }

  return {
    signal,
    strength,
    reason: finalSignalReason, // Use the generated summary reason
    breakdown
  }
}

/**
 * Main function to calculate all technical indicators
 * @param historicalData Array of historical OHLCV data
 * @returns TechnicalIndicators object with all calculated values, trading signal, and scoring breakdown
 */
export function calculateTechnicalIndicators(
  historicalData: HistoricalData[],
  newsData: { sentiment_score: number; pub_date: string }[],
  peRatio: number | undefined,
  pbRatio: number | undefined,
  marketCap: number | undefined
): TechnicalIndicators {
  if (!historicalData || historicalData.length === 0) {
    const emptyBreakdown: ScoreBreakdown = {
      maScore: 0,
      maReason: 'Insufficient data',
      rsiScore: 0,
      rsiReason: 'Insufficient data',
      momentumScore: 0,
      momentumReason: 'Insufficient data',
      priceScore: 0,
      priceReason: 'Insufficient data',
      volatilityScore: 0,
      volatilityReason: 'Insufficient data',
      newsScore: 0,
      newsReason: 'Insufficient data',
      peRatioScore: 0,
      peRatioReason: 'Insufficient data',
      pbRatioScore: 0,
      pbRatioReason: 'Insufficient data',
      marketCapScore: 0,
      marketCapReason: 'Insufficient data',
      coreMetricsScore: 0,
      coreMetricsReason: 'Insufficient data',
      totalScore: 0
    }
    return {
      sma20: null,
      sma50: null,
      rsi14: null,
      momentum: null,
      signal: 'HOLD',
      signalStrength: 0,
      signalReason: 'Insufficient historical data',
      scoreBreakdown: emptyBreakdown,
      volatility: null
    }
  }

  const prices = historicalData.map(d => d.close)
  const currentPrice = prices[prices.length - 1]

  // Calculate all indicators
  const sma20 = calculateSMA(prices, 20)
  const sma50 = calculateSMA(prices, 50)
  const rsi14 = calculateRSI(prices, 14)
  const momentum = calculateMomentum(prices, 10)

  // Calculate volatility
  const annualizedVolatility = calculateAnnualizedVolatility(historicalData.map(d => ({ date: d.date || d.datetime || '', close: d.close })));
  const volatilityRating = getVolatilityRating(annualizedVolatility);

  // Calculate news sentiment
  const avgNewsSentiment = newsData && newsData.length > 0
    ? newsData.reduce((acc, article) => acc + article.sentiment_score, 0) / newsData.length
    : null;

  // Generate trading signal with detailed breakdown
  const { signal, strength, reason, breakdown } = generateSignal(
    sma20,
    sma50,
    rsi14,
    momentum,
    currentPrice,
    volatilityRating,
    avgNewsSentiment,
    peRatio,
    pbRatio,
    marketCap
  )

  return {
    sma20,
    sma50,
    rsi14,
    momentum,
    signal,
    signalStrength: Math.round(strength),
    signalReason: reason,
    scoreBreakdown: breakdown,
    volatility: volatilityRating
  }
}

/**
 * Get historical indicator snapshots for charting
 * Returns the last N days with their indicator values
 * @param historicalData Array of historical OHLCV data
 * @param limit Number of recent days to return (default 30)
 * @returns Array of indicator snapshots
 */
export function getIndicatorSnapshots(
  historicalData: HistoricalData[],
  limit: number = 30
): IndicatorSnapshot[] {
  if (!historicalData || historicalData.length === 0) return []

  const prices = historicalData.map(d => d.close)
  const snapshots: IndicatorSnapshot[] = []
  const startIndex = Math.max(0, historicalData.length - limit)

  for (let i = startIndex; i < historicalData.length; i++) {
    const slicedPrices = prices.slice(0, i + 1)
    const date = historicalData[i].date || historicalData[i].datetime || new Date().toISOString()

    snapshots.push({
      date: date,
      close: historicalData[i].close,
      sma20: calculateSMA(slicedPrices, 20),
      sma50: calculateSMA(slicedPrices, 50),
      rsi14: calculateRSI(slicedPrices, 14)
    })
  }

  return snapshots
}