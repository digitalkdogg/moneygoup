import { NextRequest } from 'next/server';
import { GET } from '@/app/api/user/portfolio/historical-value/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { yahooFinance } from '@/utils/yahooFinanceHelper';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/yahooFinanceHelper', () => ({
  yahooFinance: {
    historical: jest.fn(),
  },
}));

describe('GET /api/user/portfolio/historical-value', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest = {
      headers: new Headers(),
      url: 'http://localhost/api/user/portfolio/historical-value?period=1w',
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
    
    // User owns 10 shares of AAPL
    (executeRawQuery as jest.Mock).mockResolvedValue([
      [{ quantity: '10', ticker: 'AAPL' }]
    ]);

    // Mock historical data from Yahoo Finance
    const mockHistoricalData = [
      { date: new Date('2026-03-10'), close: 150 },
      { date: new Date('2026-03-11'), close: 155 },
    ];
    (yahooFinance.historical as jest.Mock).mockResolvedValue(mockHistoricalData);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    // Expected data: 10 * 150 = 1500, 10 * 155 = 1550
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({ date: '2026-03-10', value: 1500 });
    expect(data[1]).toEqual({ date: '2026-03-11', value: 1550 });
  });

  test('aggregates multiple stocks correctly', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    
    // User owns 10 AAPL and 5 MSFT
    (executeRawQuery as jest.Mock).mockResolvedValue([
      [
        { quantity: '10', ticker: 'AAPL' },
        { quantity: '5', ticker: 'MSFT' }
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

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    // 2026-03-10: (10 * 100) + (5 * 200) = 1000 + 1000 = 2000
    // 2026-03-11: (10 * 110) + (5 * 210) = 1100 + 1050 = 2150
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({ date: '2026-03-10', value: 2000 });
    expect(data[1]).toEqual({ date: '2026-03-11', value: 2150 });
  });

  test('handles Yahoo Finance errors for a single stock and continues', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    
    (executeRawQuery as jest.Mock).mockResolvedValue([
      [
        { quantity: '10', ticker: 'AAPL' },
        { quantity: '5', ticker: 'INVALID' }
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

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    // Should only have AAPL data
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({ date: '2026-03-10', value: 1000 });
  });

  test('handles 500 error on database failure', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '1' } });
    (executeRawQuery as jest.Mock).mockRejectedValue(new Error('DB Connection Failed'));

    const response = await GET(mockRequest);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.message).toBe('Failed to fetch portfolio history');
  });
});
