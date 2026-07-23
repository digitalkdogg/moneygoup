/**
 * yahooFinanceHelper.test.ts — unit tests for the yahoo-finance2 wrapper.
 *
 * These tests must NEVER hit the real Yahoo network.
 *
 * Pattern: jest.resetModules() clears the module cache before each test,
 * then jest.doMock registers the factory, then require re-evaluates the
 * helper module inside that same registry so its top-level `new YahooFinance()`
 * call picks up our mock constructor. jest.isolateModules was removed because
 * in Jest 30 it creates a registry that does not reliably inherit doMock
 * registrations from the outer context, causing the real library to be used.
 */

describe('yahooFinanceHelper', () => {
  let mockQuote: jest.Mock;
  let mockQuoteSummary: jest.Mock;
  let fetchYahooQuotesForSymbols: (...args: any[]) => any;
  let fetchYahooStockSummary: (...args: any[]) => any;

  beforeEach(() => {
    mockQuote        = jest.fn();
    mockQuoteSummary = jest.fn();

    // Clear module cache so the helper re-evaluates on next require,
    // picking up the doMock registered immediately below.
    jest.resetModules();

    jest.doMock('yahoo-finance2', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        quote:        mockQuote,
        quoteSummary: mockQuoteSummary,
      })),
    }));

    const helper = require('../yahooFinanceHelper');
    fetchYahooQuotesForSymbols = helper.fetchYahooQuotesForSymbols;
    fetchYahooStockSummary     = helper.fetchYahooStockSummary;
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
