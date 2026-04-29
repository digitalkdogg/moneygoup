import { NextRequest } from 'next/server';
import { GET } from '@/app/api/dashboard/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators';
import { checkApprovalGuard } from '@/utils/approvalStatus';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/yahooFinanceHelper');
jest.mock('@/utils/technicalIndicators');
jest.mock('@/utils/approvalStatus');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('GET /api/dashboard', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 123 } });
    (checkApprovalGuard as jest.Mock).mockResolvedValue({ allowed: true });

    mockRequest = {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/dashboard'),
    } as unknown as NextRequest;
  });

  test('returns dashboard data for authenticated user', async () => {
    // 1. Mock user holdings
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([
        [{ id: 1, symbol: 'AAPL', shares: '10', purchase_price: '150', is_owned: 1 }]
      ]) // user holdings
      .mockResolvedValueOnce([
        [{ stock_id: 1, date: '2023-01-01', close: '155', volume: '1000', open: '150', high: '160', low: '145' }]
      ]) // historical prices
      .mockResolvedValueOnce([
        [{ stock_id: 1, sentiment_score: '0.5', pub_date: '2023-01-01' }]
      ]); // news

    // 2. Mock Yahoo Finance utility
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 1, symbol: 'AAPL', price: 160, daily_change: 5, companyName: 'Apple' }
    ]);

    // 3. Mock Technical Indicators
    (calculateTechnicalIndicators as jest.Mock).mockReturnValue({ signal: 'BUY' });

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.stocks).toHaveLength(1);
    expect(data.stocks[0].symbol).toBe('AAPL');
    expect(data.stocks[0].recommendation).toBe('BUY');
    expect(data.summary.totalDailyEarnings).toBe(50); // 5 * 10 shares
    expect(data.summary.totalLifetimeEarnings).toBe(100); // (160 - 150) * 10 shares
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });
});
