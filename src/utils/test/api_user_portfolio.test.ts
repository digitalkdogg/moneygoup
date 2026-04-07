import { NextRequest } from 'next/server';
import { GET } from '@/app/api/user/portfolio/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/yahooFinanceHelper', () => ({
  fetchYahooStockSummary: jest.fn(),
}));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock yahoo-finance2
const mockQuote = jest.fn();
const mockHistorical = jest.fn();

jest.mock('yahoo-finance2', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    quote: mockQuote,
    historical: mockHistorical,
  })),
}));

describe('GET /api/user/portfolio', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    mockRequest = {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/user/portfolio'),
    } as unknown as NextRequest;
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);

    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });

  test('returns portfolio with current prices and analyst data', async () => {
    const mockSession = { user: { id: 123, name: 'testuser' } };
    (getServerSession as jest.Mock).mockResolvedValue(mockSession);

    const mockPortfolioItems = [
      { symbol: 'AAPL', stock_id: 1, shares: 10, purchase_price: 150 },
      { symbol: 'TSLA', stock_id: 2, shares: 5, purchase_price: 200 },
    ];
    (executeRawQuery as jest.Mock).mockResolvedValue([mockPortfolioItems]);

    mockQuote.mockImplementation((symbol: string) => {
      if (symbol === 'AAPL') return Promise.resolve({ regularMarketPrice: 170 });
      if (symbol === 'TSLA') return Promise.resolve({ regularMarketPrice: 210 });
      return Promise.resolve({});
    });

    mockHistorical.mockResolvedValue([]);

    (fetchYahooStockSummary as jest.Mock).mockImplementation((symbol: string) => {
      if (symbol === 'AAPL') {
        return Promise.resolve({
          financialData: { recommendationKey: 'buy', numberOfAnalystOpinions: 40 }
        });
      }
      if (symbol === 'TSLA') {
        return Promise.resolve({
          financialData: { recommendationKey: 'hold', numberOfAnalystOpinions: 30 }
        });
      }
      return Promise.resolve({});
    });

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.portfolio).toHaveLength(2);
    expect(data.portfolio[0].symbol).toBe('AAPL');
    expect(data.portfolio[0].regularMarketPrice).toBe(170);
    expect(data.portfolio[0].recommendationKey).toBe('buy');
    expect(data.portfolio[0].numberOfAnalystOpinions).toBe(40);
    expect(data.portfolio[1].symbol).toBe('TSLA');
    expect(data.portfolio[1].regularMarketPrice).toBe(210);
    expect(data.portfolio[1].recommendationKey).toBe('hold');
    expect(data.portfolio[1].numberOfAnalystOpinions).toBe(30);

    // Verify totals
    expect(data.totals).toBeDefined();
    expect(data.totals.costBasis).toBe(10 * 150 + 5 * 200); // 1500 + 1000 = 2500
    expect(data.totals.marketValue).toBe(10 * 170 + 5 * 210); // 1700 + 1050 = 2750
    expect(data.totals.unrealizedNet).toBe(2750 - 2500); // 250
    expect(data.totals.unrealizedPct).toBeCloseTo((250 / 2500) * 100, 2); // 10%
    expect(data.totals.unrealizedGain).toBe(250);
    expect(data.totals.unrealizedLoss).toBe(0);
  });

  test('handles errors gracefully', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 123 } });
    (executeRawQuery as jest.Mock).mockRejectedValue(new Error('DB Error'));

    const response = await GET(mockRequest);
    expect(response.status).toBe(500);
  });
});
