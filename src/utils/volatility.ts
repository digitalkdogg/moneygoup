// src/utils/volatility.ts

export interface HistoricalPrice {
  date: string;
  close: number;
}

/**
 * Calculates the annualized volatility of a stock based on its historical prices.
 * @param prices An array of historical price objects, sorted by date.
 * @returns The annualized volatility as a percentage, or null if insufficient data.
 */
export function calculateAnnualizedVolatility(prices: HistoricalPrice[]): number | null {
  // Need at least 2 data points to calculate returns
  if (prices.length < 2) {
    return null;
  }

  // 1. Calculate logarithmic returns
  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const todayPrice = prices[i].close;
    const yesterdayPrice = prices[i - 1].close;
    if (todayPrice > 0 && yesterdayPrice > 0) {
      logReturns.push(Math.log(todayPrice / yesterdayPrice));
    }
  }

  if (logReturns.length === 0) {
    return null;
  }

  // 2. Calculate the standard deviation of the log returns
  const mean = logReturns.reduce((sum, val) => sum + val, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // 3. Annualize the volatility
  // Common practice is to use 252 trading days in a year.
  const tradingDays = 252;
  const annualizedVolatility = stdDev * Math.sqrt(tradingDays);

  // Return as a percentage
  return annualizedVolatility * 100;
}

/**
 * Converts annualized volatility percentage into a qualitative rating.
 * @param volatility The annualized volatility percentage.
 * @returns A string rating: "Low", "Medium", "High", or "N/A".
 */
export function getVolatilityRating(volatility: number | null): "Low" | "Medium" | "High" | "N/A" {
  if (volatility === null) {
    return "N/A";
  }
  if (volatility < 20) {
    return "Low";
  } else if (volatility >= 20 && volatility < 50) {
    return "Medium";
  } else {
    return "High";
  }
}
