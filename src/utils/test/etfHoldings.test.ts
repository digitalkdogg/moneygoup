// ---------------------------------------------------------------------------
// Mocks live inside beforeEach — the previous top-level jest.mock pattern was
// susceptible to cross-file jest state pollution. Other test files in the
// same worker that touch yahoo-finance2 could disturb the module registry
// such that this file's mock silently didn't apply, sending calls to the
// real Yahoo network. Defenses (same as yahooFinanceHelper.test.ts):
//   • jest.doMock inside beforeEach (not hoisted, so mock fns are freshly
//     assigned before jest ever calls the factory)
//   • jest.isolateModules around the require to guarantee '../etfHoldings'
//     evaluates in a fresh registry that resolves via the just-registered
//     mocks — regardless of what earlier tests cached
//   • jest.dontMock in afterEach so we don't leak into the next test file
// ---------------------------------------------------------------------------

const COMPANY_TICKERS_FIXTURE = [
  { ticker: 'SPY',  name: 'SPDR S&P 500 ETF Trust',  is_etf: true  },
  { ticker: 'QQQ',  name: 'Invesco QQQ Trust',        is_etf: true  },
  { ticker: 'AAPL', name: 'Apple Inc.',                is_etf: null  },
  { ticker: 'MSFT', name: 'Microsoft Corporation',     is_etf: null  },
  { ticker: 'NVDA', name: 'NVIDIA Corporation',        is_etf: null  },
  { ticker: 'AMZN', name: 'Amazon.com Inc.',           is_etf: null  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHolding(ticker: string, weight: number, parent = 'QQQ') {
  return { ticker, companyName: `${ticker} Corp`, holdingPercent: weight, parentETFTicker: parent };
}

function makeChartResult(rows = 400) {
  return {
    quotes: Array.from({ length: rows }, (_, i) => ({
      date:     new Date(Date.now() - i * 86400000),
      open:     100, high: 105, low: 95, close: 102, adjClose: 102, volume: 1_000_000,
    })),
  };
}

function makeSummary() {
  return {
    price:                 { regularMarketPrice: 150 },
    summaryDetail:         { trailingPE: 25 },
    financialData:         { revenueGrowth: 0.15, earningsGrowth: 0.20, targetMeanPrice: 175, recommendationKey: 'buy' },
    defaultKeyStatistics:  { fiftyTwoWeekChange: 0.12, beta: 1.1, priceToBook: 3.5 },
    assetProfile:          { sector: 'Technology' },
  };
}

function makeGpsResult(score = 72) {
  return {
    score,
    breakdown:    { mlpUpside: 15, mlpConfidence: 4 },
    bearishSignal: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('etfHoldings', () => {
  let fetchETFHoldings:  typeof import('../etfHoldings').fetchETFHoldings;
  let scoreETFHoldings:  typeof import('../etfHoldings').scoreETFHoldings;
  type EtfHoldingPreset = import('../etfHoldingPreset').EtfHoldingPreset;

  // Describe-scoped so test bodies can call `mockYahooFinance.chart.mock…`
  // etc. even though the actual mock objects are recreated in beforeEach.
  let mockYahooFinance:         { quoteSummary: jest.Mock; chart: jest.Mock };
  let mockExecuteRawQuery:      jest.Mock;
  let mockRunPredictionInternal: jest.Mock;
  let mockCalculateGpsScore:    jest.Mock;

  // Pin GPS_PREDICTION_MAX + remaining ETF_HOLDING_* knobs to code defaults.
  // The test fixtures assume default behavior; .env.local (production tuning)
  // overrides them and leaks into the Jest process via Next.js route module
  // imports, distorting GPS scores and surfacing gates.
  //
  // ETF_HOLDING_ALGORITHM is also stripped — when the preset module loads
  // models/etf_holding_presets.json with no env override, it resolves to
  // level 5: gpsSurfaceValue=60, minPredChangePct=1.8, maxTickers=56.
  // Tests that need different thresholds inject an `etfHoldingPreset` on
  // the scoreETFHoldings sharedContext arg directly (see the maxTickers
  // test below for an example).
  const _pinnedKeys = [
    'GPS_PREDICTION_MAX',
    'ETF_HOLDING_ALGORITHM',
    'ETF_HOLDING_MIN_CONFIDENCE',
    'ETF_HOLDING_MAX_BETA',
    'ETF_HOLDING_STALENESS_HOURS',
  ];
  const _saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of _pinnedKeys) {
      _saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GPS_PREDICTION_MAX = '3';
  });
  afterAll(() => {
    for (const k of _pinnedKeys) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  });

  beforeEach(() => {
    jest.resetModules();

    // Fresh mock objects per test — no shared state that another file's
    // jest.clearAllMocks or module registry churn can leave in a bad state.
    mockYahooFinance         = { quoteSummary: jest.fn(), chart: jest.fn() };
    mockExecuteRawQuery      = jest.fn();
    mockRunPredictionInternal = jest.fn();
    mockCalculateGpsScore    = jest.fn();

    // doMock, not mock: applies right now (not hoisted), so the factory
    // captures the mock refs we just assigned — no undefined-at-eval risk.
    jest.doMock('yahoo-finance2', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => mockYahooFinance),
    }));
    jest.doMock('@/utils/databaseHelper', () => ({
      executeRawQuery: (...args: any[]) => mockExecuteRawQuery(...args),
    }));
    jest.doMock('../stockDataHelper', () => ({
      runPredictionInternal: (...args: any[]) => mockRunPredictionInternal(...args),
    }));
    jest.doMock('../gps', () => ({
      calculateGpsScore: (...args: any[]) => mockCalculateGpsScore(...args),
    }));
    jest.doMock('../../../public/company_tickers.json', () => COMPANY_TICKERS_FIXTURE, { virtual: true });

    // isolateModules gives etfHoldings.ts (and its yahooFinanceHelper import)
    // a fresh module tree that will resolve via the just-registered mocks,
    // even if a prior test file cached the un-mocked versions.
    jest.isolateModules(() => {
      const mod = require('../etfHoldings');
      fetchETFHoldings = mod.fetchETFHoldings;
      scoreETFHoldings = mod.scoreETFHoldings;
    });
  });

  afterEach(() => {
    jest.dontMock('yahoo-finance2');
    jest.dontMock('@/utils/databaseHelper');
    jest.dontMock('../stockDataHelper');
    jest.dontMock('../gps');
    jest.dontMock('../../../public/company_tickers.json');
  });

  // ==========================================================================
  // Phase 1 — fetchETFHoldings
  // ==========================================================================

  describe('fetchETFHoldings', () => {
    test('returns top N holdings sorted by weight descending', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({
        topHoldings: {
          holdings: [
            { symbol: 'MSFT', holdingName: 'Microsoft', holdingPercent: 0.09 },
            { symbol: 'AAPL', holdingName: 'Apple',     holdingPercent: 0.13 },
            { symbol: 'NVDA', holdingName: 'NVIDIA',    holdingPercent: 0.07 },
            { symbol: 'AMZN', holdingName: 'Amazon',    holdingPercent: 0.05 },
          ],
        },
      });

      const result = await fetchETFHoldings('QQQ', 3);

      expect(result).toHaveLength(3);
      expect(result[0].ticker).toBe('AAPL');
      expect(result[1].ticker).toBe('MSFT');
      expect(result[2].ticker).toBe('NVDA');
    });

    test('injects parentETFTicker on each holding', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({
        topHoldings: { holdings: [{ symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 0.12 }] },
      });
      const result = await fetchETFHoldings('QQQ', 10);
      expect(result[0].parentETFTicker).toBe('QQQ');
    });

    test('removes holdings whose ticker is marked is_etf: true', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({
        topHoldings: {
          holdings: [
            { symbol: 'AAPL', holdingName: 'Apple',        holdingPercent: 0.10 },
            { symbol: 'SPY',  holdingName: 'SPDR S&P 500', holdingPercent: 0.08 },
            { symbol: 'QQQ',  holdingName: 'Invesco QQQ',  holdingPercent: 0.06 },
          ],
        },
      });
      const result = await fetchETFHoldings('TQQQ', 10);
      expect(result).toHaveLength(1);
      expect(result[0].ticker).toBe('AAPL');
    });

    test('returns empty array when topHoldings is absent', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({ topHoldings: null });
      expect(await fetchETFHoldings('XYZ', 10)).toEqual([]);
    });

    test('returns empty array when holdings array is empty', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({ topHoldings: { holdings: [] } });
      expect(await fetchETFHoldings('XYZ', 10)).toEqual([]);
    });

    test('returns empty array (no throw) when quoteSummary rejects', async () => {
      mockYahooFinance.quoteSummary.mockRejectedValue(new Error('Network error'));
      expect(await fetchETFHoldings('QQQ', 10)).toEqual([]);
    });

    test('respects topN cap', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({
        topHoldings: {
          holdings: Array.from({ length: 20 }, (_, i) => ({
            symbol: `TICK${i}`, holdingName: `Co ${i}`, holdingPercent: 0.05 - i * 0.001,
          })),
        },
      });
      expect(await fetchETFHoldings('QQQ', 5)).toHaveLength(5);
    });

    test('filters out blank ticker symbols', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({
        topHoldings: {
          holdings: [
            { symbol: '',     holdingName: 'Unknown',    holdingPercent: 0.05 },
            { symbol: '   ',  holdingName: 'Whitespace', holdingPercent: 0.04 },
            { symbol: 'AAPL', holdingName: 'Apple',      holdingPercent: 0.12 },
          ],
        },
      });
      const result = await fetchETFHoldings('QQQ', 10);
      expect(result).toHaveLength(1);
      expect(result[0].ticker).toBe('AAPL');
    });
  });

  // ==========================================================================
  // Phase 2 — scoreETFHoldings
  // ==========================================================================

  describe('scoreETFHoldings', () => {
    beforeEach(() => {
      // Default: no cache hit
      mockExecuteRawQuery.mockResolvedValue([[/* empty rows */]]);
      // Default chart + summary
      mockYahooFinance.chart.mockResolvedValue(makeChartResult());
      mockYahooFinance.quoteSummary.mockResolvedValue(makeSummary());
      // Default prediction result
      mockRunPredictionInternal.mockResolvedValue({
        predicted_change_pct: 2.5,
        confidence_score:     70,
        predicted_price_1m:   155,
      });
      // Default GPS result
      mockCalculateGpsScore.mockReturnValue(makeGpsResult(72));
    });

    test('scores each unique ticker only once (deduplication)', async () => {
      const holdings = [
        makeHolding('AAPL', 0.10, 'QQQ'),
        makeHolding('AAPL', 0.08, 'XLK'),  // duplicate
        makeHolding('MSFT', 0.09, 'QQQ'),
      ];

      await scoreETFHoldings(holdings);

      // chart should be called once per unique ticker (2 unique tickers)
      expect(mockYahooFinance.chart).toHaveBeenCalledTimes(2);
    });

    test('fans the score back out to all holdings sharing a ticker', async () => {
      const holdings = [
        makeHolding('AAPL', 0.10, 'QQQ'),
        makeHolding('AAPL', 0.08, 'XLK'),
      ];

      const results = await scoreETFHoldings(holdings);

      expect(results).toHaveLength(2);
      expect(results[0].gps_score).toBe(72);
      expect(results[1].gps_score).toBe(72);
      expect(results[0].parentETFTicker).toBe('QQQ');
      expect(results[1].parentETFTicker).toBe('XLK');
    });

    test('uses cached score and sets score_source: cached', async () => {
      mockExecuteRawQuery.mockResolvedValue([[{
        gps_score:    68.5,
        gps_breakdown: JSON.stringify({ mlpUpside: 14 }),
      }]]);

      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);

      expect(results[0].score_source).toBe('cached');
      expect(results[0].gps_score).toBe(68.5);
      expect(mockYahooFinance.chart).not.toHaveBeenCalled();
    });

    test('falls back to fresh score when cache returns no rows', async () => {
      mockExecuteRawQuery.mockResolvedValue([[/* empty */]]);

      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);

      expect(results[0].score_source).toBe('fresh');
      expect(mockYahooFinance.chart).toHaveBeenCalledTimes(1);
    });

    test('respects preset.maxTickers cap — processes highest-weight first', async () => {
      // Inject a preset with maxTickers=2 directly. Equivalent to setting
      // ETF_HOLDING_ALGORITHM to a level whose maxTickers resolves to 2,
      // but more explicit and decoupled from the JSON table calibration.
      const preset: EtfHoldingPreset = {
        etfGpsThreshold:   58,
        topNEtfs:          11,
        maxTickers:        2,
        gpsSurfaceValue:   60,
        minPredChangePct:  1.8,
      };

      const holdings = [
        makeHolding('AAPL', 0.13),
        makeHolding('MSFT', 0.09),
        makeHolding('NVDA', 0.07),  // should be cut
        makeHolding('AMZN', 0.05),  // should be cut
      ];

      const results = await scoreETFHoldings(holdings, { etfHoldingPreset: preset });

      expect(mockYahooFinance.chart).toHaveBeenCalledTimes(2);
      const scoredTickers = results.map(r => r.ticker);
      expect(scoredTickers).toContain('AAPL');
      expect(scoredTickers).toContain('MSFT');
      expect(scoredTickers).not.toContain('NVDA');
      expect(scoredTickers).not.toContain('AMZN');
    });

    test('silently skips a holding when prediction fails', async () => {
      mockYahooFinance.chart.mockRejectedValueOnce(new Error('Yahoo down'));

      const holdings = [
        makeHolding('AAPL', 0.10),
        makeHolding('MSFT', 0.09),
      ];

      const results = await scoreETFHoldings(holdings);

      // AAPL failed, MSFT succeeded
      expect(results).toHaveLength(1);
      expect(results[0].ticker).toBe('MSFT');
    });

    test('skips holding with insufficient history without throwing', async () => {
      mockYahooFinance.chart.mockResolvedValue(makeChartResult(100)); // < 365 rows

      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);

      expect(results).toHaveLength(0);
    });

    test('returns empty array for empty holdings input', async () => {
      const results = await scoreETFHoldings([]);
      expect(results).toHaveLength(0);
      expect(mockYahooFinance.chart).not.toHaveBeenCalled();
    });

    test('sets surfaced: true when all thresholds are met', async () => {
      // default mock: GPS 72, pred_change 2.5%, non-bearish, beta null → should surface
      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);
      expect(results[0].surfaced).toBe(true);
    });

    test('surfaced: false when GPS score below threshold', async () => {
      mockCalculateGpsScore.mockReturnValue(makeGpsResult(55)); // below L5 default 60
      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);
      expect(results[0].surfaced).toBe(false);
    });

    test('surfaced: false when predicted change below threshold', async () => {
      mockRunPredictionInternal.mockResolvedValue({
        predicted_change_pct: 1.0, // below L5 default 1.8
        confidence_score: 70,
        predicted_price_1m: 155,
      });
      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);
      expect(results[0].surfaced).toBe(false);
    });

    test('surfaced: false when bearish signal is active', async () => {
      mockCalculateGpsScore.mockReturnValue({ score: 72, breakdown: {}, bearishSignal: true });
      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);
      expect(results[0].surfaced).toBe(false);
    });

    test('populates all required ScoredETFHolding fields', async () => {
      const results = await scoreETFHoldings([makeHolding('AAPL', 0.10)]);
      const r = results[0];

      expect(typeof r.gps_score).toBe('number');
      expect(typeof r.gps_breakdown).toBe('object');
      expect(typeof r.predicted_change_pct).toBe('number');
      expect(typeof r.confidence_score).toBe('number');
      expect(typeof r.predicted_price_1m).toBe('number');
      expect(typeof r.bearish_signal).toBe('boolean');
      expect(r.score_source).toBe('fresh');
      expect(r.parentETFTicker).toBe('QQQ');
    });
  });
});
