import { POST } from '@/app/api/prediction/save/route';
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { checkOrigin } from '@/utils/originCheck';
import * as databaseHelper from '@/utils/databaseHelper';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('POST /api/prediction/save', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { id: '1', email: 'test@example.com' },
    });
    (databaseHelper.select as jest.Mock).mockResolvedValue([
      { id: 1, symbol: 'AAPL' },
    ]);
    (databaseHelper.upsert as jest.Mock).mockResolvedValue(1);
  });

  test('rejects request with no authentication', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.message).toContain('Authentication required');
  });

  test('rejects request that fails origin check', async () => {
    (checkOrigin as jest.Mock).mockReturnValue(
      new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })
    );
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(401);
  });

  test('rejects invalid JSON body', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: 'not valid json',
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Invalid JSON body');
  });

  test('rejects missing ticker field', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toBeTruthy();
  });

  test('rejects invalid ticker format', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'invalid@#$',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Invalid ticker');
  });

  test('rejects missing predicted_price_1m field', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toBeTruthy();
  });

  test('rejects non-positive predicted price', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: -150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
  });

  test('rejects unknown stock ticker', async () => {
    (databaseHelper.select as jest.Mock).mockResolvedValue([]);
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'UNKNOWN',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Stock not found');
  });

  test('successfully saves prediction with provided last_requested_at', async () => {
    const timestamp = '2026-04-10T23:34:08.560Z';
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
        last_requested_at: timestamp,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain('saved successfully');

    // Verify upsert was called with correct data
    expect(databaseHelper.upsert).toHaveBeenCalledWith(
      'user_stock_predictions',
      expect.objectContaining({
        user_id: '1',
        stock_id: 1,
        predicted_price_1m: 150.5,
        last_requested_at: timestamp.replace('T', ' ').replace('Z', ''),
      }),
      ['user_id', 'stock_id']
    );
  });

  test('successfully saves prediction with default last_requested_at', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(200);

    // Verify upsert was called with last_requested_at set to current time (approximately)
    expect(databaseHelper.upsert).toHaveBeenCalledWith(
      'user_stock_predictions',
      expect.objectContaining({
        user_id: '1',
        stock_id: 1,
        predicted_price_1m: 150.5,
      }),
      ['user_id', 'stock_id']
    );

    const callArgs = (databaseHelper.upsert as jest.Mock).mock.calls[0][1];
    expect(callArgs.last_requested_at).toBeTruthy();
  });

  test('uses id as user_id from session', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(200);

    const callArgs = (databaseHelper.upsert as jest.Mock).mock.calls[0][1];
    expect(callArgs.user_id).toBe('1');
  });

  test('handles database upsert errors gracefully', async () => {
    (databaseHelper.upsert as jest.Mock).mockRejectedValue(
      new Error('Database connection failed')
    );
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.message).toContain('Failed to save prediction');
  });

  test('handles stock lookup errors gracefully', async () => {
    (databaseHelper.select as jest.Mock).mockRejectedValue(
      new Error('Database error')
    );
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.message).toContain('Failed to save prediction');
  });

  test('accepts valid ISO 8601 timestamps for last_requested_at', async () => {
    const validTimestamps = [
      '2026-04-10T23:34:08.560Z',
      '2026-04-10T23:34:08.000Z',
    ];

    for (const timestamp of validTimestamps) {
      mockRequest = new NextRequest('http://localhost/api/prediction/save', {
        method: 'POST',
        body: JSON.stringify({
          ticker: 'AAPL',
          predicted_price_1m: 150.5,
          last_requested_at: timestamp,
        }),
      });

      // Reset mocks for each iteration
      (databaseHelper.select as jest.Mock).mockResolvedValue([
        { id: 1, symbol: 'AAPL' },
      ]);
      (databaseHelper.upsert as jest.Mock).mockResolvedValue(1);

      const response = await POST(mockRequest);
      expect(response.status).toBe(200);
    }
  });

  test('rejects invalid timestamp for last_requested_at', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
        last_requested_at: 'not-a-timestamp',
      }),
    });

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
  });

  test('accepts internal API key authentication', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-internal-secret',
      },
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
        user_id: '1',
      }),
    });

    // Mock the internal secret env variable
    process.env.DEEPMONEY_INTERNAL_SECRET = 'test-internal-secret';

    const response = await POST(mockRequest);
    expect(response.status).toBe(200);

    // Verify upsert was called with the provided user_id
    expect(databaseHelper.upsert).toHaveBeenCalledWith(
      'user_stock_predictions',
      expect.objectContaining({
        user_id: '1',
        stock_id: 1,
        predicted_price_1m: 150.5,
      }),
      ['user_id', 'stock_id']
    );
  });

  test('rejects internal API call with missing user_id', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-internal-secret',
      },
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
        // Missing user_id
      }),
    });

    process.env.DEEPMONEY_INTERNAL_SECRET = 'test-internal-secret';

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('user_id');
  });

  test('rejects invalid internal API key and falls back to session auth', async () => {
    mockRequest = new NextRequest('http://localhost/api/prediction/save', {
      method: 'POST',
      headers: {
        'x-api-key': 'wrong-secret',
      },
      body: JSON.stringify({
        ticker: 'AAPL',
        predicted_price_1m: 150.5,
        user_id: '1',
      }),
    });

    process.env.DEEPMONEY_INTERNAL_SECRET = 'correct-secret';
    // Clear mock to simulate no valid session
    (getServerSession as jest.Mock).mockResolvedValue(null);

    const response = await POST(mockRequest);
    expect(response.status).toBe(401);
  });
});
