import { NextRequest } from 'next/server';
import { POST } from '@/app/api/user/stocks/route';
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

describe('POST /api/user/stocks', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 123 } });
  });

  const createMockRequest = (body: any) => {
    return {
      json: jest.fn().mockResolvedValue(body),
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/user/stocks'),
    } as unknown as NextRequest;
  };

  test('purchases stock successfully', async () => {
    const body = { stock_id: 1, shares: 10, purchase_price: 150 };
    mockRequest = createMockRequest(body);

    (executeRawQuery as jest.Mock).mockResolvedValue([{}]);

    const response = await POST(mockRequest);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.message).toBe('Stock purchased successfully');
    expect(executeRawQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_stocks'), expect.any(Array));
  });

  test('returns 400 for invalid input', async () => {
    const body = { stock_id: -1, shares: 0, purchase_price: -10 }; // Invalid
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const body = { stock_id: 1, shares: 10, purchase_price: 150 };
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(401);
  });
});
