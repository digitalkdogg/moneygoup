import { NextRequest } from 'next/server';
import { GET } from '@/app/api/dashboard/recommendations/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';

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

describe('GET /api/dashboard/recommendations', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '123' } });

    mockRequest = {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/dashboard/recommendations'),
    } as unknown as NextRequest;
  });

  test('returns BUY recommendation when predicted price is >= 3% higher', async () => {
    // 1. Mock predictions (current 100, predicted 103 -> +3%)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [
        { stock_id: 1, symbol: 'AAPL', predicted_price_1m: '103', last_requested_at: '2026-04-11T12:00:00Z', is_purchased: 1 }
      ]
    ]);

    // 2. Mock Yahoo Finance utility (current price 100)
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 1, symbol: 'AAPL', price: 100, companyName: 'Apple' }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].symbol).toBe('AAPL');
    expect(data.recommendations[0].action).toBe('BUY');
    expect(data.recommendations[0].deltaPct).toBe(3);
    expect(data.recommendations[0].scope).toBe('portfolio');
  });

  test('returns SELL recommendation when predicted price is <= 3% lower', async () => {
    // 1. Mock predictions (current 100, predicted 97 -> -3%)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [
        { stock_id: 2, symbol: 'TSLA', predicted_price_1m: '97', last_requested_at: '2026-04-11T12:00:00Z', is_purchased: 1 }
      ]
    ]);

    // 2. Mock Yahoo Finance utility (current price 100)
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 2, symbol: 'TSLA', price: 100, companyName: 'Tesla' }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].symbol).toBe('TSLA');
    expect(data.recommendations[0].action).toBe('SELL');
    expect(data.recommendations[0].deltaPct).toBe(-3);
    expect(data.recommendations[0].scope).toBe('portfolio');
  });

  test('returns no recommendation when delta is between -3% and 3%', async () => {
    // 1. Mock predictions (current 100, predicted 102 -> +2%)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [
        { stock_id: 3, symbol: 'MSFT', predicted_price_1m: '102', last_requested_at: '2026-04-11T12:00:00Z', is_purchased: 1 }
      ]
    ]);

    // 2. Mock Yahoo Finance utility (current price 100)
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 3, symbol: 'MSFT', price: 100, companyName: 'Microsoft' }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.recommendations).toHaveLength(0);
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });
});
