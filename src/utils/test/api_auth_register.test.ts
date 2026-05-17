import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/register/route';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';

jest.mock('bcryptjs');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/rateLimitMiddleware');
jest.mock('@/lib/email');
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

  // ── Happy path ──────────────────────────────────────────────────────

  test('registers a new user successfully', async () => {
    const body = { username: 'testuser', email: 'testuser@example.com', password: 'password123' };
    mockRequest = createMockRequest(body);

    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[]])              // email check: none found
      .mockResolvedValueOnce([[]])              // username check: none found
      .mockResolvedValueOnce([{ insertId: 1 }]); // insert

    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

    const response = await POST(mockRequest);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.message).toBe('Account created and awaiting admin approval');
    expect(data.userId).toBe(1);
    expect(executeRawQuery).toHaveBeenCalledTimes(3);
  });

  test('accepts a password that is exactly 8 characters with one digit', async () => {
    const body = { username: 'testuser', email: 'test@example.com', password: 'abcdefg1' };
    mockRequest = createMockRequest(body);

    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 2 }]);

    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

    const response = await POST(mockRequest);
    expect(response.status).toBe(201);
  });

  // ── Conflict checks ─────────────────────────────────────────────────

  test('returns 409 when email is already registered', async () => {
    const body = { username: 'newuser', email: 'existing@example.com', password: 'password123' };
    mockRequest = createMockRequest(body);

    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ id: 1 }]]); // email exists

    const response = await POST(mockRequest);
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.message).toBe('An account with this email address is already registered.');
  });

  test('returns 409 when username is already taken', async () => {
    const body = { username: 'existinguser', email: 'new@example.com', password: 'password123' };
    mockRequest = createMockRequest(body);

    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[]])           // email check: none found
      .mockResolvedValueOnce([[{ id: 1 }]]); // username exists

    const response = await POST(mockRequest);
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.message).toBe('This username is already taken.');
  });

  // ── Password policy ─────────────────────────────────────────────────

  test('returns 400 when password is fewer than 8 characters', async () => {
    const body = { username: 'testuser', email: 'test@example.com', password: 'pass1' };
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Validation error');
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('returns 400 when password has no digit', async () => {
    const body = { username: 'testuser', email: 'test@example.com', password: 'passwordonly' };
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Validation error');
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  // ── Other input validation ───────────────────────────────────────────

  test('returns 400 for invalid input (zod error)', async () => {
    const body = { username: 'us', password: 'pw' }; // username too short, missing email
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Validation error');
  });

  // ── Guards ──────────────────────────────────────────────────────────

  test('respects rate limiting', async () => {
    (checkRateLimit as jest.Mock).mockReturnValue({ status: 429 });
    const body = { username: 'testuser', email: 'test@example.com', password: 'password123' };
    mockRequest = createMockRequest(body);

    const response = await POST(mockRequest);
    expect(response.status).toBe(429);
  });
});
