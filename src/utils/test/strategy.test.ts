/**
 * strategy.test.ts
 *
 * Runs 5 realistic stock prediction profiles through the aggressiveness-only
 * strategy machinery and asserts:
 *   • GPS score itself is strategy-independent (every aggressiveness yields
 *     the same score for the same stock)
 *   • aggressiveness gates are correctly ordered (safe strictest, aggressive loosest)
 *   • envFloorMultiplier values are 1.05 / 1.0 / 0.95
 *   • each stock clears the discovery floor for exactly the aggressiveness
 *     levels we'd expect at the real-world env=80 baseline
 *
 * The 5 stocks span the surfacing spectrum: KO (clears none), WMT (clears
 * none), AAPL (clears only aggressive), TSLA (clears neutral + aggressive),
 * NVDA (clears all three).
 */

import { calculateGpsScore, GpsMetrics, GpsPredictionResult } from '../gps';
import { resolveStrategy, Aggressiveness } from '../strategy';

// Pin GPS_PREDICTION_MAX to the code default (3). Without this, the test
// fixtures' hardcoded expected GPS values drift when .env.local sets a
// different value (e.g. production tuning of 15) and that env leaks into
// the Jest process via Next.js route module imports elsewhere in the suite.
let _prevGpsPredictionMax: string | undefined;
beforeAll(() => {
  _prevGpsPredictionMax = process.env.GPS_PREDICTION_MAX;
  process.env.GPS_PREDICTION_MAX = '3';
});
afterAll(() => {
  if (_prevGpsPredictionMax === undefined) delete process.env.GPS_PREDICTION_MAX;
  else process.env.GPS_PREDICTION_MAX = _prevGpsPredictionMax;
});

const AGGRESSIVENESS: Aggressiveness[] = ['safe', 'neutral', 'aggressive'];

interface StockFixture {
  ticker: string;
  description: string;
  metrics: GpsMetrics;
  prediction: GpsPredictionResult;
}

// --------------------------------------------------------------------------
// 5 stock fixtures spanning the recommendation surfacing spectrum.
// Numbers are representative but engineered so each fixture lands in a
// distinct bucket at the user's real-world env baseline of 80.
// --------------------------------------------------------------------------
const STOCKS: StockFixture[] = [
  {
    ticker:      'WMT',
    description: 'Walmart — defensive consumer staple, low beta, moderate growth',
    metrics: {
      analystUpside:     0.08,
      revenueGrowthPct:  0.05,
      earningsGrowthPct: 0.10,
      priceChange52w:    0.18,
      technicalScore:    6,
      recommendationKey: 'buy',
    },
    prediction: {
      predictedChangePct1m: 2.5,
      confidenceScore:      70,
    },
  },
  {
    ticker:      'NVDA',
    description: 'NVIDIA — high-growth AI leader, capped fundamentals + strong momentum',
    metrics: {
      analystUpside:     0.18,
      revenueGrowthPct:  0.94,
      earningsGrowthPct: 1.20,
      priceChange52w:    0.85,
      technicalScore:    10,
      recommendationKey: 'strongBuy',
    },
    prediction: {
      predictedChangePct1m: 5.5,
      confidenceScore:      75,
    },
  },
  {
    ticker:      'AAPL',
    description: 'Apple — quality large-cap, solid fundamentals, moderate technicals',
    metrics: {
      analystUpside:     0.20,
      revenueGrowthPct:  0.10,
      earningsGrowthPct: 0.20,
      priceChange52w:    0.25,
      technicalScore:    8,
      recommendationKey: 'buy',
    },
    prediction: {
      predictedChangePct1m: 4.0,
      confidenceScore:      75,
    },
  },
  {
    ticker:      'KO',
    description: 'Coca-Cola — dividend-defensive, low growth, low predicted upside',
    metrics: {
      analystUpside:     0.05,
      revenueGrowthPct:  0.03,
      earningsGrowthPct: 0.05,
      priceChange52w:    0.06,
      technicalScore:    3,
      recommendationKey: 'hold',
    },
    prediction: {
      predictedChangePct1m: 1.2,
      confidenceScore:      65,
    },
  },
  {
    ticker:      'TSLA',
    description: 'Tesla — volatile growth stock, high beta, strong predicted upside',
    metrics: {
      analystUpside:     0.10,
      revenueGrowthPct:  0.15,
      earningsGrowthPct: 0.25,
      priceChange52w:    0.45,
      technicalScore:    11,
      recommendationKey: 'buy',
    },
    prediction: {
      predictedChangePct1m: 6.5,
      confidenceScore:      65,
    },
  },
];

function gpsFor(stock: StockFixture) {
  return calculateGpsScore(stock.metrics, stock.prediction);
}

function discoveryFloor(envBaseline: number, aggressiveness: Aggressiveness) {
  return envBaseline * resolveStrategy({ aggressiveness }).gates.envFloorMultiplier;
}

// Real-world env from the user's setup
const ENV_DISCOVERY = 80;

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('5-stock GPS validity', () => {
  test.each(STOCKS.map(s => [s.ticker, s] as const))(
    '%s — GPS score is valid (0–100), finite breakdown',
    (_ticker, stock) => {
      const result = gpsFor(stock);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      for (const v of Object.values(result.breakdown)) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  );

  test('every stock has bullish 1m prediction → bearishSignal false for all', () => {
    for (const stock of STOCKS) {
      expect(gpsFor(stock).bearishSignal).toBe(false);
    }
  });
});

describe('expected GPS ordering across the 5 fixtures', () => {
  // The fixtures are intentionally engineered so NVDA > TSLA > AAPL > WMT > KO.
  // If a tweak to gps.ts re-orders them, that's worth flagging.
  test('NVDA > TSLA > AAPL > WMT > KO', () => {
    const ordered = ['NVDA', 'TSLA', 'AAPL', 'WMT', 'KO'];
    const scores = ordered.map(t => gpsFor(STOCKS.find(s => s.ticker === t)!).score);
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    }
  });
});

describe('aggressiveness multipliers (envFloorMultiplier)', () => {
  test('multiplier values are 1.05 / 1.0 / 0.95', () => {
    expect(resolveStrategy({ aggressiveness: 'safe' }).gates.envFloorMultiplier).toBe(1.05);
    expect(resolveStrategy({ aggressiveness: 'neutral' }).gates.envFloorMultiplier).toBe(1.0);
    expect(resolveStrategy({ aggressiveness: 'aggressive' }).gates.envFloorMultiplier).toBe(0.95);
  });

  test('env=80 produces discovery floors of 84 / 80 / 76', () => {
    expect(discoveryFloor(80, 'safe')).toBeCloseTo(84);
    expect(discoveryFloor(80, 'neutral')).toBeCloseTo(80);
    expect(discoveryFloor(80, 'aggressive')).toBeCloseTo(76);
  });
});

describe('aggressiveness gate ordering', () => {
  test('safe gates strictest, aggressive loosest, neutral between', () => {
    const safe = resolveStrategy({ aggressiveness: 'safe' }).gates;
    const neutral = resolveStrategy({ aggressiveness: 'neutral' }).gates;
    const aggressive = resolveStrategy({ aggressiveness: 'aggressive' }).gates;

    expect(safe.confidenceFloor).toBeGreaterThan(neutral.confidenceFloor);
    expect(neutral.confidenceFloor).toBeGreaterThan(aggressive.confidenceFloor);

    expect(safe.gpsGate).toBeGreaterThan(neutral.gpsGate);
    expect(neutral.gpsGate).toBeGreaterThan(aggressive.gpsGate);

    expect(safe.predChangeGate).toBeGreaterThan(neutral.predChangeGate);
    expect(neutral.predChangeGate).toBeGreaterThan(aggressive.predChangeGate);

    expect(safe.betaCutoff).toBeLessThan(neutral.betaCutoff);
    expect(neutral.betaCutoff).toBeLessThan(aggressive.betaCutoff);
  });
});

describe('strategy independence of GPS score', () => {
  test('GPS score does NOT change with aggressiveness — only the gates do', () => {
    // calculateGpsScore takes no strategy arg; the score is identical for any user.
    for (const stock of STOCKS) {
      const expected = gpsFor(stock).score;
      for (const _agg of AGGRESSIVENESS) {
        expect(gpsFor(stock).score).toBe(expected);
      }
    }
  });
});

describe('discovery surfacing at env=80', () => {
  // For each stock, assert exactly which aggressiveness levels would surface
  // it as a discovery card. This is the user-facing behavior of the whole
  // strategy system, end-to-end on the dashboard.
  test.each([
    ['KO',   { safe: false, neutral: false, aggressive: false }],
    ['WMT',  { safe: false, neutral: false, aggressive: false }],
    ['AAPL', { safe: false, neutral: false, aggressive: true  }],
    ['TSLA', { safe: false, neutral: true,  aggressive: true  }],
    ['NVDA', { safe: true,  neutral: true,  aggressive: true  }],
  ] as const)('%s clears the discovery floor for the expected aggressiveness levels', (ticker, expected) => {
    const stock = STOCKS.find(s => s.ticker === ticker)!;
    const gps = gpsFor(stock).score;
    for (const a of AGGRESSIVENESS) {
      const clears = gps >= discoveryFloor(ENV_DISCOVERY, a);
      expect({ ticker, aggressiveness: a, clears }).toEqual({ ticker, aggressiveness: a, clears: expected[a] });
    }
  });
});

describe('bucket coverage report (informational)', () => {
  // Prints a wide matrix: one row per stock, columns showing GPS and the
  // discovery floor clearance for each aggressiveness level. Run with
  // `--verbose` to see the output.
  test('prints the 5-stock × 3-aggressiveness clearing matrix', () => {
    const header = ['ticker'.padEnd(8),
                    'GPS'.padStart(6),
                    'pred%'.padStart(7),
                    'safe(84)'.padStart(10),
                    'neutral(80)'.padStart(13),
                    'aggr(76)'.padStart(10),
                    'description'.padEnd(0)].join(' | ');

    const rows: string[] = [header];
    for (const stock of STOCKS) {
      const result = gpsFor(stock);
      const cells = AGGRESSIVENESS.map(a => {
        const floor = discoveryFloor(ENV_DISCOVERY, a);
        const margin = result.score - floor;
        const sign = margin >= 0 ? '+' : '';
        return `${result.score >= floor ? 'PASS' : 'fail'} ${sign}${margin.toFixed(1)}`;
      });
      rows.push([
        stock.ticker.padEnd(8),
        result.score.toFixed(1).padStart(6),
        stock.prediction.predictedChangePct1m!.toFixed(1).padStart(7),
        cells[0].padStart(10),
        cells[1].padStart(13),
        cells[2].padStart(10),
        stock.description,
      ].join(' | '));
    }

    // eslint-disable-next-line no-console
    console.log(`\nGPS × aggressiveness surfacing at env discovery floor = ${ENV_DISCOVERY}\n${rows.join('\n')}\n`);

    expect(rows.length).toBe(STOCKS.length + 1);
  });
});
