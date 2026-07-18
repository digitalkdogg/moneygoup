/**
 * yahooFinanceHelper.test.ts — unit tests for the yahoo-finance2 wrapper.
 *
 * These tests must NEVER hit the real Yahoo network. The pattern below is
 * deliberately verbose to survive cross-file jest state pollution seen in
 * the full suite: other test files that touch yahoo-finance2 can leave the
 * module registry in a state where a top-level `jest.mock` gets bypassed
 * for this file, sending calls to the real library and failing on Yahoo's
 * "No set-cookie header" crumb error.
 *
 * Defenses used:
 *   • `jest.doMock` inside beforeEach (not hoisted, no closure timing issues)
 *   • `jest.isolateModules` around require() to force a fresh module tree
 *     that resolves via the just-registered mock
 *   • Fresh mock fns per test — no outer-scope singletons that can get
 *     cleared by another file's jest.clearAllMocks
 */

describe('yahooFinanceHelper', () => {
  let mockQuote: jest.Mock;
  let mockQuoteSummary: jest.Mock;
  let fetchYahooQuotesForSymbols: (...args: any[]) => any;
  let fetchYahooStockSummary: (...args: any[]) => any;

  beforeEach(() => {
    mockQuote        = jest.fn();
    mockQuoteSummary = jest.fn();

    // doMock (not mock): applies right now, not hoisted. The factory is called
    // when yahoo-finance2 is next resolved, at which point our mock fns above
    // are already assigned.
    jest.doMock('yahoo-finance2', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        quote:        mockQuote,
        quoteSummary: mockQuoteSummary,
      })),
    }));

    // isolateModules guarantees the helper module is re-evaluated within a
    // fresh registry so its top-level `new YahooFinance(...)` picks up our
    // just-registered mock, regardless of what earlier test files left behind.
    jest.isolateModules(() => {
      const helper = require('../yahooFinanceHelper');
      fetchYahooQuotesForSymbols = helper.fetchYahooQuotesForSymbols;
      fetchYahooStockSummary     = helper.fetchYahooStockSummary;
    });
  });

  afterEach(() => {
    jest.dontMock('yahoo-finance2');
  });

  describe('fetchYahooQuotesForSymbols', () => {
    test('returns formatted quotes', async () => {
      const symbols = ['AAPL', 'MSFT'];
      const stockIdMap = new Map([['AAPL', 1], ['MSFT', 2]]);

      mockQuote.mockResolvedValue([
        { symbol: 'AAPL', regularMarketPrice: 150, longName: 'Apple Inc.' },
        { symbol: 'MSFT', regularMarketPrice: 300, longName: 'Microsoft Corp.' },
      ]);

      const result = await fetchYahooQuotesForSymbols(symbols, stockIdMap);

      expect(result).toHaveLength(2);
      expect(result[0].stock_id).toBe(1);
      expect(result[0].price).toBe(150);
      expect(result[1].stock_id).toBe(2);
      expect(result[1].price).toBe(300);
    });

    test('returns empty array if no symbols provided', async () => {
      const result = await fetchYahooQuotesForSymbols([], new Map());
      expect(result).toEqual([]);
      expect(mockQuote).not.toHaveBeenCalled();
    });
  });

  describe('fetchYahooStockSummary', () => {
    test('calls quoteSummary with correct parameters', async () => {
      mockQuoteSummary.mockResolvedValue({ assetProfile: {} });
      const result = await fetchYahooStockSummary('AAPL');
      expect(mockQuoteSummary).toHaveBeenCalledWith('AAPL', expect.any(Object));
      expect(result).toBeDefined();
    });
  });
});
