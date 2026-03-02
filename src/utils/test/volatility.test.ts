import { calculateAnnualizedVolatility, getVolatilityRating } from '../volatility';

describe('volatility', () => {
  describe('calculateAnnualizedVolatility', () => {
    test('returns null for less than 2 data points', () => {
      expect(calculateAnnualizedVolatility([])).toBeNull();
      expect(calculateAnnualizedVolatility([{ date: '2023-01-01', close: 100 }])).toBeNull();
    });

    test('calculates volatility for steady price (0 volatility)', () => {
      const prices = [
        { date: '2023-01-01', close: 100 },
        { date: '2023-01-02', close: 100 },
        { date: '2023-01-03', close: 100 },
      ];
      expect(calculateAnnualizedVolatility(prices)).toBe(0);
    });

    test('calculates volatility for changing prices', () => {
      const prices = [
        { date: '2023-01-01', close: 100 },
        { date: '2023-01-02', close: 110 },
        { date: '2023-01-03', close: 100 },
      ];
      const vol = calculateAnnualizedVolatility(prices);
      expect(vol).toBeGreaterThan(0);
      // log(1.1) approx 0.0953
      // log(100/110) approx -0.0953
      // mean = 0
      // variance = (0.0953^2 + (-0.0953)^2) / 1 = 2 * 0.00908 = 0.01816
      // stdDev = sqrt(0.01816) = 0.1347
      // annualized = 0.1347 * sqrt(252) = 0.1347 * 15.87 = 2.138
      // percentage = 213.8%
      expect(vol).toBeCloseTo(213.8, 0);
    });

    test('ignores non-positive prices', () => {
      const prices = [
        { date: '2023-01-01', close: 100 },
        { date: '2023-01-02', close: 0 },
        { date: '2023-01-03', close: 110 },
      ];
      // Only returns between 1 and 2, and 2 and 3 are calculated if prices > 0.
      // Here only logReturns would be empty or have issues.
      // The code checks if (todayPrice > 0 && yesterdayPrice > 0)
      expect(calculateAnnualizedVolatility(prices)).toBeNull();
    });
  });

  describe('getVolatilityRating', () => {
    test('returns N/A for null', () => {
      expect(getVolatilityRating(null)).toBe('N/A');
    });

    test('returns Low for < 20', () => {
      expect(getVolatilityRating(15)).toBe('Low');
    });

    test('returns Medium for 20-50', () => {
      expect(getVolatilityRating(25)).toBe('Medium');
      expect(getVolatilityRating(49.9)).toBe('Medium');
    });

    test('returns High for >= 50', () => {
      expect(getVolatilityRating(50)).toBe('High');
      expect(getVolatilityRating(100)).toBe('High');
    });
  });
});
