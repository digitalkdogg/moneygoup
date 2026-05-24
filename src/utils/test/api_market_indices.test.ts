import { NextRequest } from 'next/server';
import { GET } from '@/app/api/market/indices/route';
import { getServerSession } from 'next-auth';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';
import { checkOrigin } from '@/utils/originCheck';
import { marketIndicesCache } from '@/utils/cache';

// Mock dependencies
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth', () => ({ authOptions: {} }));
jest.mock('@/utils/originCheck');
jest.mock('@/utils/yahooFinanceHelper');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock('@/utils/approvalStatus', () => ({
  checkApprovalGuard: jest.fn().mockResolvedValue({ allowed: true }),
}));

describe('GET /api/market/indices', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    marketIndicesCache.clear();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1 } });

    mockRequest = {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/market/indices'),
    } as unknown as NextRequest;
  });

  test('returns major indices including VIX', async () => {
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { symbol: '^GSPC', price: 5000, daily_change: 50 },
      { symbol: '^IXIC', price: 16000, daily_change: 160 },
      { symbol: '^DJI', price: 39000, daily_change: 390 },
      { symbol: '^VIX', price: 15, daily_change: -0.5 }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.indices).toHaveLength(4);
    const symbols = data.indices.map((i: any) => i.symbol);
    expect(symbols).toContain('^GSPC');
    expect(symbols).toContain('^IXIC');
    expect(symbols).toContain('^DJI');
    expect(symbols).toContain('^VIX');

    const vix = data.indices.find((i: any) => i.symbol === '^VIX');
    expect(vix.label).toBe('VIX');
    expect(vix.price).toBe(15);
    expect(vix.changePercent).toBeCloseTo((-0.5 / (15 - (-0.5))) * 100, 2);
  });

  test('handles missing price or change data', async () => {
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { symbol: '^GSPC', price: null, daily_change: null },
      { symbol: '^IXIC', price: 16000, daily_change: 160 },
      { symbol: '^DJI', price: 39000, daily_change: 390 },
      { symbol: '^VIX', price: 15, daily_change: -0.5 }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    const sp500 = data.indices.find((i: any) => i.symbol === '^GSPC');
    expect(sp500.price).toBeNull();
    expect(sp500.changePercent).toBeNull();
  });
});
