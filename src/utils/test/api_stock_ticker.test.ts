import { NextRequest } from 'next/server';
import { GET } from '@/app/api/stock_data/[ticker]/route';
import { getServerSession } from 'next-auth';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/rateLimitMiddleware');
jest.mock('@/utils/yahooFinanceHelper');
jest.mock('@/utils/technicalIndicators');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock global fetch
global.fetch = jest.fn();

describe('GET /api/stock_data/[ticker]', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (checkRateLimit as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1 } });

    mockRequest = {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/stock_data/AAPL'),
    } as unknown as NextRequest;
  });

  test('returns stock data successfully', async () => {
    const params = { ticker: 'AAPL' };

    // Mock Yahoo Summary
    (fetchYahooStockSummary as jest.Mock).mockResolvedValue({
      price: {
        symbol: 'AAPL',
        longName: 'Apple Inc.',
        regularMarketPrice: 150,
        regularMarketOpen: 148,
        regularMarketDayHigh: 151,
        regularMarketDayLow: 147,
        regularMarketVolume: 1000000,
        regularMarketPreviousClose: 149,
        regularMarketTime: Date.now() / 1000,
        fullExchangeName: 'Nasdaq',
      },
      summaryDetail: {
        trailingPE: 25,
        priceToBook: 5,
        marketCap: 2000000000,
      },
      assetProfile: {
        sector: 'Technology',
        industry: 'Consumer Electronics',
        longBusinessSummary: 'Apple Inc. designs, manufactures, and markets smartphones, personal computers, tablets, wearables, and accessories worldwide.',
      },
    });

    // Mock internal fetches
    (global.fetch as jest.Mock).mockImplementation((url) => {
      if (url.includes('/historical')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ historicalData: { AAPL: [{ date: '2023-01-01', close: 140 }] } }),
        });
      }
      if (url.includes('/news')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ articles: { AAPL: [{ sentiment_score: 0.5, pub_date: '2023-01-01' }] } }),
        });
      }
      if (url.includes('/analyst')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ priceTarget: {}, recommendationTrend: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    (calculateTechnicalIndicators as jest.Mock).mockReturnValue({ signal: 'BUY' });

    const response = await GET(mockRequest, { params });
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.stock.symbol).toBe('AAPL');
    expect(data.indicators.signal).toBe('BUY');
    expect(data.analyst).toBeDefined();
    expect(data.analyst.priceTarget).toBeDefined();
    expect(data.analyst.recommendationTrend).toBeDefined();
  });

  test('returns analyst data correctly', async () => {
    const params = { ticker: 'AAPL' };

    // Mock Yahoo Summary with analyst data
    (fetchYahooStockSummary as jest.Mock).mockResolvedValue({
      price: {
        symbol: 'AAPL',
        regularMarketPrice: 150,
        regularMarketTime: Date.now() / 1000,
      },
      summaryDetail: {},
      assetProfile: {},
      financialData: {
        recommendationKey: 'buy',
        numberOfAnalystOpinions: 40,
        targetLowPrice: 130,
        targetMeanPrice: 160,
        targetMedianPrice: 155,
        targetHighPrice: 180,
      },
      recommendationTrend: {
        trend: [{ period: '0m', strongBuy: 10, buy: 20, hold: 5, sell: 3, strongSell: 2 }]
      }
    });

    // Mock internal fetches
    (global.fetch as jest.Mock).mockImplementation((url) => {
      if (url.includes('/analyst')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            recommendationKey: 'buy',
            numberOfAnalystOpinions: 40,
            priceTarget: { mean: 160 },
            recommendationTrend: [{ strongBuy: 10 }]
          })
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const response = await GET(mockRequest, { params });
    const data = await response.json();

    expect(data.analyst.recommendationKey).toBe('buy');
    expect(data.analyst.numberOfAnalystOpinions).toBe(40);
    expect(data.analyst.priceTarget.mean).toBe(160);
    expect(data.analyst.recommendationTrend).toHaveLength(1);
    expect(data.analyst.recommendationTrend[0].strongBuy).toBe(10);
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const response = await GET(mockRequest, { params: { ticker: 'AAPL' } });
    expect(response.status).toBe(401);
  });

  test('returns 400 for invalid ticker', async () => {
    const response = await GET(mockRequest, { params: { ticker: 'INVALID_TICKER_TOO_LONG' } });
    expect(response.status).toBe(400);
  });
});
