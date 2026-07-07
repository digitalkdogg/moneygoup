// Remove top level imports for dynamic loading in tests
// import { fetchYahooQuotesForSymbols, fetchYahooStockSummary } from '../yahooFinanceHelper';

// Use mock prefix so it's hoisted with the factory
var mockYahooFinance = {
  quote: jest.fn(),
  quoteSummary: jest.fn(),
};

jest.mock('yahoo-finance2', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockYahooFinance),
}));

describe('yahooFinanceHelper', () => {
  let fetchYahooQuotesForSymbols: any;
  let fetchYahooStockSummary: any;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Re-register the mock after resetModules — when the full test suite runs,
    // other files that also touch yahoo-finance2 (e.g. etfHoldings.test.ts)
    // can disturb the module registry such that this file's single top-level
    // jest.mock doesn't survive the re-require below. The etfHoldings test
    // uses this same pattern; without it, running the suite in the wrong
    // order sends the real yahoo-finance2 code to the network and fails on
    // "No set-cookie header present in Yahoo's response."
    jest.mock('yahoo-finance2', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => mockYahooFinance),
    }));

    const helper = require('../yahooFinanceHelper');
    fetchYahooQuotesForSymbols = helper.fetchYahooQuotesForSymbols;
    fetchYahooStockSummary = helper.fetchYahooStockSummary;
  });

  describe('fetchYahooQuotesForSymbols', () => {
    test('returns formatted quotes', async () => {
      const symbols = ['AAPL', 'MSFT'];
      const stockIdMap = new Map([['AAPL', 1], ['MSFT', 2]]);
      
      mockYahooFinance.quote.mockResolvedValue([
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
      expect(mockYahooFinance.quote).not.toHaveBeenCalled();
    });
  });

  describe('fetchYahooStockSummary', () => {
    test('calls quoteSummary with correct parameters', async () => {
      mockYahooFinance.quoteSummary.mockResolvedValue({ assetProfile: {} });
      const result = await fetchYahooStockSummary('AAPL');
      expect(mockYahooFinance.quoteSummary).toHaveBeenCalledWith('AAPL', expect.any(Object));
      expect(result).toBeDefined();
    });
  });
});
