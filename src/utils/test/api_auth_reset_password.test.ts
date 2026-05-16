import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/auth/reset-password/route';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';

jest.mock('bcryptjs');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/rateLimitMiddleware');
jest.mock('@/utils/rateLimiter', () => ({ resetPasswordLimiter: {} }));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const VALID_TOKEN = 'a'.repeat(64);

const FUTURE = new Date(Date.now() + 3_600_000);
const PAST   = new Date(Date.now() - 1_000);

const VALID_TOKEN_ROW = { id: 7, user_id: 42, expires_at: FUTURE, used_at: null };
const USED_TOKEN_ROW  = { id: 7, user_id: 42, expires_at: FUTURE, used_at: new Date() };
const EXPIRED_ROW     = { id: 7, user_id: 42, expires_at: PAST,   used_at: null };

const createGetRequest = (token: string) =>
  ({
    nextUrl: new URL(`http://localhost/api/auth/reset-password?token=${token}`),
  } as unknown as NextRequest);

const createPostRequest = (body: any) =>
  ({
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers(),
    nextUrl: new URL('http://localhost/api/auth/reset-password'),
  } as unknown as NextRequest);

describe('GET /api/auth/reset-password', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns valid:true for a valid unused unexpired token', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[VALID_TOKEN_ROW]]);

    const res = await GET(createGetRequest(VALID_TOKEN));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(true);
  });

  test('returns 400 when token is not 64 characters', async () => {
    const res = await GET(createGetRequest('tooshort'));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.valid).toBe(false);
    expect(data.message).toBe('Invalid or missing reset token.');
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('returns 400 when token is not found in DB', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]); // empty result

    const res = await GET(createGetRequest(VALID_TOKEN));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.valid).toBe(false);
    expect(data.message).toBe('Invalid or expired reset link.');
  });

  test('returns 400 for an already-used token', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[USED_TOKEN_ROW]]);

    const res = await GET(createGetRequest(VALID_TOKEN));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.valid).toBe(false);
    expect(data.message).toBe('This reset link has already been used.');
  });

  test('returns 400 for an expired token', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[EXPIRED_ROW]]);

    const res = await GET(createGetRequest(VALID_TOKEN));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.valid).toBe(false);
    expect(data.message).toBe('This reset link has expired.');
  });
});

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (checkRateLimit as jest.Mock).mockReturnValue(null);
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_newpassword');
  });

  // ── Happy path ──────────────────────────────────────────────────────

  test('resets password for a valid token', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[VALID_TOKEN_ROW]]) // lookupToken
      .mockResolvedValueOnce([{}])                // UPDATE users
      .mockResolvedValueOnce([{}]);               // UPDATE password_reset_tokens

    const res = await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.message).toBe('Password updated successfully.');
    expect(bcrypt.hash).toHaveBeenCalledWith('newpass1', 10);
  });

  test('updates users table with the new password hash', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[VALID_TOKEN_ROW]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));

    const updateUsersCall = (executeRawQuery as jest.Mock).mock.calls[1];
    expect(updateUsersCall[0]).toContain('UPDATE users');
    expect(updateUsersCall[0]).toContain('password_hash');
    expect(updateUsersCall[1]).toEqual(['hashed_newpassword', VALID_TOKEN_ROW.user_id]);
  });

  test('marks the token as used after resetting', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[VALID_TOKEN_ROW]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));

    const markUsedCall = (executeRawQuery as jest.Mock).mock.calls[2];
    expect(markUsedCall[0]).toContain('UPDATE password_reset_tokens');
    expect(markUsedCall[0]).toContain('used_at');
    expect(markUsedCall[1]).toEqual([VALID_TOKEN_ROW.id]);
  });

  // ── Token validation ────────────────────────────────────────────────

  test('returns 400 when token is wrong length (Zod)', async () => {
    const res = await POST(createPostRequest({ token: 'short', password: 'newpass1' }));

    expect(res.status).toBe(400);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('returns 400 when token is not found in DB', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]); // empty

    const res = await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.message).toBe('Invalid or expired reset link.');
  });

  test('returns 400 for an already-used token', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[USED_TOKEN_ROW]]);

    const res = await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.message).toBe('This reset link has already been used.');
  });

  test('returns 400 for an expired token', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[EXPIRED_ROW]]);

    const res = await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.message).toBe('This reset link has expired.');
  });

  // ── Input validation ────────────────────────────────────────────────

  test('returns 400 when password is too short (Zod)', async () => {
    const res = await POST(createPostRequest({ token: VALID_TOKEN, password: 'abc' }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.message).toBe('Password must be at least 6 characters');
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  // ── Guards ──────────────────────────────────────────────────────────

  test('respects rate limiting', async () => {
    (checkRateLimit as jest.Mock).mockReturnValue({ status: 429 });

    const res = await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));

    expect(res.status).toBe(429);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('respects origin check', async () => {
    (checkOrigin as jest.Mock).mockReturnValue({ status: 403 });

    const res = await POST(createPostRequest({ token: VALID_TOKEN, password: 'newpass1' }));

    expect(res.status).toBe(403);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });
});
