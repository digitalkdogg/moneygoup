import { NextRequest } from 'next/server';
import { GET } from '@/app/api/prediction/deepmoney/route';
import { getServerSession } from 'next-auth';
import { checkOrigin } from '@/utils/originCheck';
import { deepmoneyLimiter } from '@/utils/rateLimiter';
import YahooFinance from 'yahoo-finance2';
import { analyzeStocks } from '@/app/api/prediction/deepmoney/analyzer';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/rateLimiter');
jest.mock('yahoo-finance2');
jest.mock('@/app/api/prediction/deepmoney/analyzer');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock global fetch
global.fetch = jest.fn();

describe('GET /api/prediction/deepmoney', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, email: 'test@example.com' } });
    (deepmoneyLimiter.check as jest.Mock).mockResolvedValue({ allowed: true });

    mockRequest = {
      headers: new Headers(),
      url: 'http://localhost/api/prediction/deepmoney',
      nextUrl: new URL('http://localhost/api/prediction/deepmoney'),
    } as unknown as NextRequest;
  });

  test('successfully discovers and enriches tickers', async () => {
    // Mock RSS feed fetch
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      text: jest.fn().mockResolvedValue(`
        <rss><channel><item>
          <title>AAPL stock is rising</title>
          <description>$MSFT is also mentioned.</description>
        </item></channel></rss>
      `),
    });

    // Mock Yahoo Finance
    const mockYahoo = {
      quoteSummary: jest.fn().mockResolvedValue({
        price: { longName: 'Apple Inc.', regularMarketPrice: 150, regularMarketChangePercent: 0.02, marketCap: 2000000000 },
        summaryDetail: { trailingPE: 25 },
        financialData: { revenueGrowth: 0.1, grossMargins: 0.4 },
        defaultKeyStatistics: { priceToBook: 5 },
        assetProfile: { sector: 'Technology' }
      }),
      historical: jest.fn().mockResolvedValue([]),
    };
    (YahooFinance as unknown as jest.Mock).mockImplementation(() => mockYahoo);

    // Mock analyzer
    (analyzeStocks as jest.Mock).mockResolvedValue([
      { ticker: 'AAPL', name: 'Apple Inc.', tradingSignalScore: 5, prediction_1m: 1.5 }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.stocks).toHaveLength(1);
    expect(data.stocks[0].ticker).toBe('AAPL');
  });

  test('returns 401 if not authenticated', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });

  test('returns 403 if rate limit exceeded', async () => {
    (deepmoneyLimiter.check as jest.Mock).mockResolvedValue({ allowed: false });
    
    const response = await GET(mockRequest);
    expect(response.status).toBe(403);
  });
});
