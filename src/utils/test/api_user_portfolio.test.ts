import { NextRequest } from 'next/server';
import { GET } from '@/app/api/user/portfolio/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock yahoo-finance2
const mockYahooFinance = {
  quote: jest.fn(),
  historical: jest.fn(),
};

jest.mock('yahoo-finance2', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockYahooFinance),
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

  test('returns portfolio with current prices', async () => {
    const mockSession = { user: { id: 123, name: 'testuser' } };
    (getServerSession as jest.Mock).mockResolvedValue(mockSession);

    const mockPortfolioItems = [
      { symbol: 'AAPL', stock_id: 1, shares: 10, purchase_price: 150 },
      { symbol: 'TSLA', stock_id: 2, shares: 5, purchase_price: 200 },
    ];
    (executeRawQuery as jest.Mock).mockResolvedValue([mockPortfolioItems]);

    mockYahooFinance.quote.mockImplementation((symbol: string) => {
      if (symbol === 'AAPL') return Promise.resolve({ regularMarketPrice: 170 });
      if (symbol === 'TSLA') return Promise.resolve({ regularMarketPrice: 210 });
      return Promise.resolve({});
    });

    mockYahooFinance.historical.mockResolvedValue([]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.portfolio).toHaveLength(2);
    expect(data.portfolio[0].symbol).toBe('AAPL');
    expect(data.portfolio[0].regularMarketPrice).toBe(170);
    expect(data.portfolio[1].symbol).toBe('TSLA');
    expect(data.portfolio[1].regularMarketPrice).toBe(210);
  });

  test('handles errors gracefully', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 123 } });
    (executeRawQuery as jest.Mock).mockRejectedValue(new Error('DB Error'));

    const response = await GET(mockRequest);
    expect(response.status).toBe(500);
  });
});
