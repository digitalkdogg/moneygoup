import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/register/route';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';

// Mock dependencies
jest.mock('bcryptjs');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/rateLimitMiddleware');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('POST /api/auth/register', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (checkRateLimit as jest.Mock).mockReturnValue(null);
  });

  const createMockRequest = (body: any) => {
    return {
      json: jest.fn().mockResolvedValue(body),
      clone: jest.fn().mockReturnValue({
        json: jest.fn().mockResolvedValue(body),
      }),
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/auth/register'),
    } as unknown as NextRequest;
  };

  test('registers a new user successfully', async () => {
    const body = { username: 'testuser', password: 'password123' };
    mockRequest = createMockRequest(body);

    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[]]) // Check existing user: none found
      .mockResolvedValueOnce([{ insertId: 1 }]); // Insert user

    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

    const response = await POST(mockRequest);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.message).toBe('User registered successfully');
    expect(data.userId).toBe(1);
    expect(executeRawQuery).toHaveBeenCalledTimes(2);
  });

  test('returns 409 if user already exists', async () => {
    const body = { username: 'existinguser', password: 'password123' };
    mockRequest = createMockRequest(body);

    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ id: 1 }]]);

    const response = await POST(mockRequest);
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.message).toBe('Username already exists');
  });

  test('returns 400 for invalid input (zod error)', async () => {
    const body = { username: 'us', password: 'pw' }; // Too short
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Validation error');
  });

  test('respects rate limiting', async () => {
    (checkRateLimit as jest.Mock).mockReturnValue({ status: 429 }); // Mock rate limit hit
    const body = { username: 'testuser', password: 'password123' };
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(429);
  });
});
