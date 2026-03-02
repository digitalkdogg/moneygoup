import { calculateTechnicalIndicators, getIndicatorSnapshots } from '../technicalIndicators';

describe('technicalIndicators', () => {
  const mockHistoricalData = Array.from({ length: 60 }, (_, i) => ({
    date: `2023-01-${i + 1}`,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 100 + i,
    volume: 1000,
  }));

  describe('calculateTechnicalIndicators', () => {
    test('returns default values for empty data', () => {
      const result = calculateTechnicalIndicators([], [], undefined, undefined, undefined);
      expect(result.signal).toBe('HOLD');
      expect(result.sma20).toBeNull();
    });

    test('calculates SMA values correctly', () => {
      const result = calculateTechnicalIndicators(mockHistoricalData, [], undefined, undefined, undefined);
      // SMA20 of 100, 101, ..., 159 (last 20: 140...159)
      // average of 140...159 is 149.5
      expect(result.sma20).toBe(149.5);
      // SMA50 of 100, 101, ..., 159 (last 50: 110...159)
      // average of 110...159 is 134.5
      expect(result.sma50).toBe(134.5);
    });

    test('calculates RSI value correctly', () => {
      const result = calculateTechnicalIndicators(mockHistoricalData, [], undefined, undefined, undefined);
      expect(result.rsi14).toBeDefined();
      expect(result.rsi14).toBeGreaterThan(0);
      expect(result.rsi14).toBeLessThanOrEqual(100);
    });

    test('generates a BUY signal for upward trend', () => {
      // Upward trend is already in mockHistoricalData
      const result = calculateTechnicalIndicators(mockHistoricalData, [], 10, 1, 300_000_000_000);
      expect(result.signal).toBe('BUY');
    });

    test('generates a SELL signal for downward trend', () => {
      const downwardData = Array.from({ length: 60 }, (_, i) => ({
        date: `2023-01-${i + 1}`,
        open: 100 - i,
        high: 105 - i,
        low: 95 - i,
        close: 100 - i,
        volume: 1000,
      }));
      const result = calculateTechnicalIndicators(downwardData, [], 50, 10, 1_000_000_000);
      expect(result.signal).toBe('SELL');
    });
  });

  describe('getIndicatorSnapshots', () => {
    test('returns correct number of snapshots', () => {
      const snapshots = getIndicatorSnapshots(mockHistoricalData, 10);
      expect(snapshots.length).toBe(10);
    });

    test('snapshots contain indicator values', () => {
      const snapshots = getIndicatorSnapshots(mockHistoricalData, 5);
      expect(snapshots[4].close).toBe(159);
      expect(snapshots[4].sma20).toBe(149.5);
    });
  });
});
