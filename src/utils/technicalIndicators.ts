export interface HistoricalData {
  date?: string
  datetime?: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TechnicalIndicators {
  sma20: number | null
  sma50: number | null
  rsi14: number | null
  momentum: number | null
  signal: 'BUY' | 'SELL' | 'HOLD'
  signalStrength: number
  signalReason: string
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
 */
function generateSignal(
  sma20: number | null,
  sma50: number | null,
  rsi: number | null,
  momentum: number | null,
  currentPrice: number
): { signal: 'BUY' | 'SELL' | 'HOLD'; strength: number; reason: string } {
  let score = 0
  const reasons: string[] = []

  // MA Crossover Strategy (weight: 3)
  if (sma20 !== null && sma50 !== null) {
    if (sma20 > sma50) {
      score += 3
      reasons.push('Bullish MA crossover')
    } else if (sma20 < sma50) {
      score -= 3
      reasons.push('Bearish MA crossover')
    }
  }

  // RSI Strategy (weight: 2)
  if (rsi !== null) {
    if (rsi < 30) {
      score += 2
      reasons.push('RSI Oversold (<30)')
    } else if (rsi > 70) {
      score -= 2
      reasons.push('RSI Overbought (>70)')
    } else if (rsi > 40 && rsi < 60) {
      reasons.push('RSI Neutral (40-60)')
    }
  }

  // Momentum Strategy (weight: 2)
  if (momentum !== null) {
    if (momentum > 0) {
      score += 2
      reasons.push('Positive momentum')
    } else if (momentum < 0) {
      score -= 2
      reasons.push('Negative momentum')
    }
  }

  // Price vs MA Strategy (weight: 1)
  if (sma50 !== null) {
    if (currentPrice > sma50) {
      score += 1
      reasons.push('Price above 50-day MA')
    } else if (currentPrice < sma50) {
      score -= 1
      reasons.push('Price below 50-day MA')
    }
  }

  // Determine signal based on score
  let signal: 'BUY' | 'SELL' | 'HOLD'
  if (score >= 4) {
    signal = 'BUY'
  } else if (score <= -4) {
    signal = 'SELL'
  } else {
    signal = 'HOLD'
  }

  // Calculate signal strength (0-100)
  const strength = Math.min(100, Math.abs(score) * 10)

  return {
    signal,
    strength,
    reason: reasons.length > 0 ? reasons.join('; ') : 'Insufficient data for signals'
  }
}

/**
 * Main function to calculate all technical indicators
 * @param historicalData Array of historical OHLCV data
 * @returns TechnicalIndicators object with all calculated values and trading signal
 */
export function calculateTechnicalIndicators(historicalData: HistoricalData[]): TechnicalIndicators {
  if (!historicalData || historicalData.length === 0) {
    return {
      sma20: null,
      sma50: null,
      rsi14: null,
      momentum: null,
      signal: 'HOLD',
      signalStrength: 0,
      signalReason: 'Insufficient historical data'
    }
  }

  const prices = historicalData.map(d => d.close)
  const currentPrice = prices[prices.length - 1]

  // Calculate all indicators
  const sma20 = calculateSMA(prices, 20)
  const sma50 = calculateSMA(prices, 50)
  const rsi14 = calculateRSI(prices, 14)
  const momentum = calculateMomentum(prices, 10)

  // Generate trading signal
  const { signal, strength, reason } = generateSignal(sma20, sma50, rsi14, momentum, currentPrice)

  return {
    sma20,
    sma50,
    rsi14,
    momentum,
    signal,
    signalStrength: Math.round(strength),
    signalReason: reason
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
