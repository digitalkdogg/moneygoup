import { percentileRank, calibrateFromPercentile } from '@/utils/gpsCalibration';

describe('percentileRank', () => {
  it('returns 0 for an empty universe', () => {
    expect(percentileRank([], 50)).toBe(0);
  });

  it('ranks the lowest value near 0 and the highest near 1', () => {
    const scores = [10, 20, 30, 40, 50];
    expect(percentileRank(scores, 10)).toBeCloseTo(0.1, 5);
    expect(percentileRank(scores, 50)).toBeCloseTo(0.9, 5);
  });

  it('uses mid-rank averaging for ties', () => {
    // Three stocks tied at 40 out of 5: countBelow=2, countEqual=3 -> (2 + 1.5) / 5
    const scores = [10, 20, 40, 40, 40];
    expect(percentileRank(scores, 40)).toBeCloseTo(3.5 / 5, 5);
  });

  it('handles a value below the whole universe', () => {
    expect(percentileRank([10, 20, 30], 5)).toBe(0);
  });

  it('handles a value above the whole universe', () => {
    expect(percentileRank([10, 20, 30], 100)).toBe(1);
  });

  it('is monotonic non-decreasing across a sorted universe', () => {
    const scores = [5, 12, 12, 30, 41, 41, 41, 60, 81];
    let prev = -Infinity;
    for (const s of scores) {
      const rank = percentileRank(scores, s);
      expect(rank).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = rank;
    }
  });
});

describe('calibrateFromPercentile', () => {
  it('maps 0 to 0 and 1 to 100', () => {
    expect(calibrateFromPercentile(0)).toBe(0);
    expect(calibrateFromPercentile(1)).toBeCloseTo(100, 5);
  });

  it('maps the default target percentile (0.9) to the default target score (80)', () => {
    expect(calibrateFromPercentile(0.9)).toBeCloseTo(80, 5);
  });

  it('honors custom target percentile/score', () => {
    expect(calibrateFromPercentile(0.75, { targetPercentile: 0.75, targetScore: 65 })).toBeCloseTo(65, 5);
  });

  it('is monotonic increasing in percentile', () => {
    const points = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1];
    let prev = -1;
    for (const p of points) {
      const score = calibrateFromPercentile(p);
      expect(score).toBeGreaterThan(prev);
      prev = score;
    }
  });

  it('clamps out-of-range percentiles into [0, 100]', () => {
    expect(calibrateFromPercentile(-0.5)).toBe(0);
    expect(calibrateFromPercentile(1.5)).toBeCloseTo(100, 5);
  });

  it('rejects invalid target parameters', () => {
    expect(() => calibrateFromPercentile(0.5, { targetPercentile: 0 })).toThrow();
    expect(() => calibrateFromPercentile(0.5, { targetPercentile: 1 })).toThrow();
    expect(() => calibrateFromPercentile(0.5, { targetScore: 0 })).toThrow();
    expect(() => calibrateFromPercentile(0.5, { targetScore: 100 })).toThrow();
  });
});
