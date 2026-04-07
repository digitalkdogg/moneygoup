import { NextRequest } from 'next/server';
import { GET } from '@/app/api/dashboard/analyst-ratings/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
import { checkOrigin } from '@/utils/originCheck';
import { analystRatingsCache } from '@/utils/cache';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/yahooFinanceHelper');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('GET /api/dashboard/analyst-ratings', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    analystRatingsCache.clear();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1 } });

    mockRequest = {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/dashboard/analyst-ratings'),
    } as unknown as NextRequest;
  });

  test('returns normalized ratings for held symbols', async () => {
    // 1. Mock user holdings
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [{ symbol: 'AAPL' }, { symbol: 'MSFT' }]
    ]);

    // 2. Mock Yahoo Finance summary
    (fetchYahooStockSummary as jest.Mock)
      .mockResolvedValueOnce({
        financialData: {
          recommendationKey: 'strongBuy',
          recommendationMean: 1.2,
          numberOfAnalystOpinions: 40
        }
      })
      .mockResolvedValueOnce({
        financialData: {
          recommendationKey: 'hold',
          recommendationMean: 3.0,
          numberOfAnalystOpinions: 25
        }
      });

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.ratings).toHaveLength(2);
    expect(data.ratings[0]).toEqual({
      symbol: 'AAPL',
      primary: 'Strong Buy',
      score: 1.2,
      count: 40
    });
    expect(data.ratings[1]).toEqual({
      symbol: 'MSFT',
      primary: 'Hold',
      score: 3.0,
      count: 25
    });
  });

  test('handles symbols with no analyst data', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [{ symbol: 'UNKNOWN' }]
    ]);
    (fetchYahooStockSummary as jest.Mock).mockRejectedValueOnce(new Error('Not found'));

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.ratings).toHaveLength(1);
    expect(data.ratings[0].primary).toBe('Unknown');
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });
});
