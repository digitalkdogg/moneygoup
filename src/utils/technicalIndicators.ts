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
  newsSentiment: number | null
): { signal: 'BUY' | 'SELL' | 'HOLD'; strength: number; reason: string; breakdown: ScoreBreakdown } {
  let totalScore = 0
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
  totalScore += maScore

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
  totalScore += rsiScore

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
  totalScore += momentumScore

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
  totalScore += priceScore
  
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
  totalScore += volatilityScore;

  // ============ News Sentiment Strategy (weight: 2) ============
  let newsScore = 0;
  let newsReason = '';
  if (newsSentiment !== null) {
    if (newsSentiment > 1) {
      newsScore = 2;
      newsReason = `Positive News Sentiment (Score: ${newsSentiment.toFixed(2)})`;
      reasons.push('Positive News');
    } else if (newsSentiment < -1) {
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
  totalScore += newsScore;


  // Determine signal based on total score
  let signal: 'BUY' | 'SELL' | 'HOLD'
  if (totalScore >= 4) {
    signal = 'BUY'
  } else if (totalScore <= -4) {
    signal = 'SELL'
  } else {
    signal = 'HOLD'
  }

  // Calculate signal strength (0-100)
  const strength = Math.min(100, Math.abs(totalScore) * 10)

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
    totalScore
  }

  return {
    signal,
    strength,
    reason: reasons.length > 0 ? reasons.join('; ') : 'Insufficient data for signals',
    breakdown
  }
}

/**
 * Main function to calculate all technical indicators
 * @param historicalData Array of historical OHLCV data
 * @returns TechnicalIndicators object with all calculated values, trading signal, and scoring breakdown
 */
export function calculateTechnicalIndicators(historicalData: HistoricalData[], newsData: { sentiment_score: number; pub_date: string }[]): TechnicalIndicators {
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
  const { signal, strength, reason, breakdown } = generateSignal(sma20, sma50, rsi14, momentum, currentPrice, volatilityRating, avgNewsSentiment)

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