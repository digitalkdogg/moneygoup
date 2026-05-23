import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { forgotPasswordLimiter } from '@/utils/rateLimiter';
import { sendPasswordResetEmail } from '@/lib/email';

const logger = createLogger('api/auth/forgot-password');

const schema = z.object({
  email: z.string().email('Invalid email address'),
});

const SUCCESS_MESSAGE = 'If that email address is registered, you will receive a password reset link shortly.';

export async function POST(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const rateLimitResponse = checkRateLimit(request, forgotPasswordLimiter, 'forgot-password');
  if (rateLimitResponse) return rateLimitResponse;

  const successResponse = NextResponse.json({ message: SUCCESS_MESSAGE }, { status: 200 });

  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return successResponse;

    const { email } = parsed.data;

    const [rows] = await executeRawQuery(
      'SELECT id, approval_status FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    const users = rows as Array<{ id: number; approval_status: string }>;
    if (!Array.isArray(users) || users.length === 0 || users[0].approval_status !== 'approved') {
      return successResponse;
    }

    const userId = users[0].id;

    // Remove any existing unused tokens for this user
    await executeRawQuery(
      'DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL',
      [userId]
    );

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await executeRawQuery(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [userId, tokenHash, expiresAt]
    );

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    if (process.env.NODE_ENV === 'production' && baseUrl.includes('localhost')) {
      logger.error('NEXTAUTH_URL is not set to a production URL — password reset emails will be broken');
    }
    const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`;

    await sendPasswordResetEmail(email, resetUrl);
    logger.info('Password reset email sent', { userId });

  } catch (error) {
    logger.error('Error in forgot-password', {
      error: error instanceof Error
        ? { message: error.message, stack: error.stack }
        : JSON.stringify(error),
    });
  }

  return successResponse;
}
