import { NextRequest } from 'next/server';
import { GET } from '@/app/api/dashboard/on/route';
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
jest.mock('@/utils/approvalStatus', () => ({
  checkApprovalGuard: jest.fn().mockResolvedValue({ allowed: true }),
}));

describe('GET /api/dashboard/on', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 123 } });

    mockRequest = {
      headers: new Headers(),
      url: 'http://localhost/api/dashboard/on?ticker=AAPL',
    } as unknown as NextRequest;
  });

  test('returns portfolio and watchlist status with shares and purchase details', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValue([
      [{
        stockId: 42,
        onWatchlist: 0,
        onPortfolio: 1,
        shares: 10.5,
        purchaseDate: '2023-01-01T12:00:00Z',
        purchasePrice: 150.25,
        watchlistAddedDate: null,
        watchlistPriceAdded: 0
      }]
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data).toEqual({
      ticker: 'AAPL',
      stockId: 42,
      onWatchlist: false,
      onPortfolio: true,
      shares: 10.5,
      purchaseDate: '2023-01-01T12:00:00Z',
      purchasePrice: 150.25,
      watchlistAddedDate: null,
      watchlistPriceAdded: 0
    });
  });

  test('returns default values if no record found', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValue([[]]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data).toEqual({
      ticker: 'AAPL',
      stockId: null,
      onWatchlist: false,
      onPortfolio: false,
      shares: 0,
      purchaseDate: null,
      purchasePrice: 0,
      watchlistAddedDate: null,
      watchlistPriceAdded: 0
    });
  });

  test('returns 400 if ticker is missing', async () => {
    mockRequest.url = 'http://localhost/api/dashboard/on';
    const response = await GET(mockRequest);
    expect(response.status).toBe(400);
  });

  test('returns 401 if unauthorized', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });
});
