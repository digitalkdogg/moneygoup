import { NextRequest } from 'next/server';
import { GET } from '@/app/api/user/portfolio/historical-value/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { checkOrigin } from '@/utils/originCheck';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/yahooFinanceHelper', () => ({
  yahooFinance: {
    historical: jest.fn(),
  },
}));
jest.mock('@/utils/approvalStatus', () => ({
  checkApprovalGuard: jest.fn().mockResolvedValue({ allowed: true }),
}));

describe('GET /api/user/portfolio/historical-value', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    const url = 'http://localhost/api/user/portfolio/historical-value?period=1w';
    mockRequest = {
      headers: new Headers(),
      nextUrl: {
        searchParams: new URL(url).searchParams,
      },
    } as unknown as NextRequest;
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);

    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });

  test('returns empty array if user has no stocks', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    (executeRawQuery as jest.Mock).mockResolvedValue([[]]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual([]);
  });

  test('returns historical portfolio value correctly', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    
    (executeRawQuery as jest.Mock).mockResolvedValue([
      [{ 
        ticker: 'AAPL', 
        shares: '10', 
        initial_purchase_date: new Date('2026-03-10T12:00:00.000Z') 
      }]
    ]);

    const mockHistoricalData = [
      { date: new Date('2026-03-10'), close: 150 },
      { date: new Date('2026-03-11'), close: 155 },
    ];
    (yahooFinance.historical as jest.Mock).mockResolvedValue(mockHistoricalData);

    // Mock the date to be constant
    jest.useFakeTimers().setSystemTime(new Date('2026-03-12'));

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    // The new logic iterates day-by-day, so we expect more data points
    // It should start on the purchase date
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data[0]).toEqual({ date: '2026-03-10', value: 1500 });
    expect(data[1]).toEqual({ date: '2026-03-11', value: 1550 });

    jest.useRealTimers();
  });

  test('aggregates multiple stocks correctly', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    
    (executeRawQuery as jest.Mock).mockResolvedValue([
      [
        { ticker: 'AAPL', shares: '10', initial_purchase_date: new Date('2026-03-10T12:00:00.000Z') },
        { ticker: 'MSFT', shares: '5', initial_purchase_date: new Date('2026-03-10T12:00:00.000Z') }
      ]
    ]);

    (yahooFinance.historical as jest.Mock).mockImplementation((ticker: string) => {
      if (ticker === 'AAPL') {
        return Promise.resolve([
          { date: new Date('2026-03-10'), close: 100 },
          { date: new Date('2026-03-11'), close: 110 },
        ]);
      }
      if (ticker === 'MSFT') {
        return Promise.resolve([
          { date: new Date('2026-03-10'), close: 200 },
          { date: new Date('2026-03-11'), close: 210 },
        ]);
      }
      return Promise.resolve([]);
    });

    jest.useFakeTimers().setSystemTime(new Date('2026-03-12'));
    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.length).toBeGreaterThanOrEqual(2);
    // 2026-03-10: (10 * 100) + (5 * 200) = 1000 + 1000 = 2000
    // 2026-03-11: (10 * 110) + (5 * 210) = 1100 + 1050 = 2150
    expect(data[0]).toEqual({ date: '2026-03-10', value: 2000 });
    expect(data[1]).toEqual({ date: '2026-03-11', value: 2150 });

    jest.useRealTimers();
  });

  test('handles Yahoo Finance errors for a single stock and continues', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    
    (executeRawQuery as jest.Mock).mockResolvedValue([
      [
        { ticker: 'AAPL', shares: '10', initial_purchase_date: new Date('2026-03-10T12:00:00.000Z') },
        { ticker: 'INVALID', shares: '5', initial_purchase_date: new Date('2026-03-10T12:00:00.000Z') }
      ]
    ]);

    (yahooFinance.historical as jest.Mock).mockImplementation((ticker: string) => {
      if (ticker === 'AAPL') {
        return Promise.resolve([
          { date: new Date('2026-03-10'), close: 100 },
        ]);
      }
      if (ticker === 'INVALID') {
        return Promise.reject(new Error('Symbol not found'));
      }
      return Promise.resolve([]);
    });

    jest.useFakeTimers().setSystemTime(new Date('2026-03-11'));
    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    // Should only have AAPL data
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0]).toEqual({ date: '2026-03-10', value: 1000 });
    jest.useRealTimers();
  });

  test('handles 500 error on database failure', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    (executeRawQuery as jest.Mock).mockRejectedValue(new Error('DB Connection Failed'));

    const response = await GET(mockRequest);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.message).toBe('Failed to reconstruct portfolio history');
  });
});
