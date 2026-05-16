import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/forgot-password/route';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { sendPasswordResetEmail } from '@/lib/email';

jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/rateLimitMiddleware');
jest.mock('@/lib/email');
jest.mock('@/utils/rateLimiter', () => ({ forgotPasswordLimiter: {} }));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const SUCCESS_MESSAGE =
  'If that email address is registered, you will receive a password reset link shortly.';

const APPROVED_USER = { id: 42, approval_status: 'approved' };

const createMockRequest = (body: any) =>
  ({
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers(),
    nextUrl: new URL('http://localhost/api/auth/forgot-password'),
  } as unknown as NextRequest);

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (checkRateLimit as jest.Mock).mockReturnValue(null);
    (sendPasswordResetEmail as jest.Mock).mockResolvedValue(undefined);
  });

  // ── Info-leak prevention ────────────────────────────────────────────

  test('returns generic success when email is not registered', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]);

    const res = await POST(createMockRequest({ email: 'nobody@example.com' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.message).toBe(SUCCESS_MESSAGE);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('returns generic success when account is pending', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ id: 5, approval_status: 'pending' }]]);

    const res = await POST(createMockRequest({ email: 'pending@example.com' }));

    expect(res.status).toBe(200);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('returns generic success when account is rejected', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ id: 6, approval_status: 'rejected' }]]);

    const res = await POST(createMockRequest({ email: 'rejected@example.com' }));

    expect(res.status).toBe(200);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('returns generic success for invalid email format without hitting DB', async () => {
    const res = await POST(createMockRequest({ email: 'not-an-email' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.message).toBe(SUCCESS_MESSAGE);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('returns generic success even when sendPasswordResetEmail throws', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[APPROVED_USER]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);
    (sendPasswordResetEmail as jest.Mock).mockRejectedValue(new Error('Resend API error: domain not verified'));

    const res = await POST(createMockRequest({ email: 'user@example.com' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.message).toBe(SUCCESS_MESSAGE);
  });

  // ── Happy path ──────────────────────────────────────────────────────

  test('sends reset email for an approved user', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[APPROVED_USER]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    const res = await POST(createMockRequest({ email: 'user@example.com' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.message).toBe(SUCCESS_MESSAGE);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      'user@example.com',
      expect.stringContaining('/reset-password?token=')
    );
  });

  test('deletes existing unused tokens before inserting a new one', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[APPROVED_USER]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await POST(createMockRequest({ email: 'user@example.com' }));

    const deleteCall = (executeRawQuery as jest.Mock).mock.calls[1];
    expect(deleteCall[0]).toContain('DELETE FROM password_reset_tokens');
    expect(deleteCall[1]).toEqual([APPROVED_USER.id]);
  });

  test('inserts token with correct user_id, 64-char SHA-256 hash, and ~1h expiry', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[APPROVED_USER]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    const before = Date.now();
    await POST(createMockRequest({ email: 'user@example.com' }));
    const after = Date.now();

    const insertCall = (executeRawQuery as jest.Mock).mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO password_reset_tokens');
    const [insertedUserId, tokenHash, expiresAt] = insertCall[1];
    expect(insertedUserId).toBe(APPROVED_USER.id);
    expect(typeof tokenHash).toBe('string');
    expect(tokenHash).toHaveLength(64); // SHA-256 hex
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 3601_000);
  });

  test('uses NEXTAUTH_URL env var as the base for the reset link', async () => {
    process.env.NEXTAUTH_URL = 'https://myapp.example.com';

    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[APPROVED_USER]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await POST(createMockRequest({ email: 'user@example.com' }));

    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      'user@example.com',
      expect.stringContaining('https://myapp.example.com/reset-password?token=')
    );

    delete process.env.NEXTAUTH_URL;
  });

  // ── Guards ──────────────────────────────────────────────────────────

  test('respects rate limiting', async () => {
    (checkRateLimit as jest.Mock).mockReturnValue({ status: 429 });

    const res = await POST(createMockRequest({ email: 'user@example.com' }));

    expect(res.status).toBe(429);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('respects origin check', async () => {
    (checkOrigin as jest.Mock).mockReturnValue({ status: 403 });

    const res = await POST(createMockRequest({ email: 'user@example.com' }));

    expect(res.status).toBe(403);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });
});
