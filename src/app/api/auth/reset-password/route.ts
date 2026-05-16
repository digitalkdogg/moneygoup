import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { resetPasswordLimiter } from '@/utils/rateLimiter';

const logger = createLogger('api/auth/reset-password');

const schema = z.object({
  token: z.string().length(64, 'Invalid token format'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(100),
});

type TokenRow = { id: number; user_id: number; expires_at: Date; used_at: Date | null };

async function lookupToken(tokenHash: string): Promise<TokenRow | null> {
  const [rows] = await executeRawQuery(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ? LIMIT 1',
    [tokenHash]
  );
  const tokens = rows as TokenRow[];
  return Array.isArray(tokens) && tokens.length > 0 ? tokens[0] : null;
}

function validateTokenRow(token: TokenRow): string | null {
  if (token.used_at) return 'This reset link has already been used.';
  if (new Date() > new Date(token.expires_at)) return 'This reset link has expired.';
  return null;
}

// GET ?token=... — validate without consuming
export async function GET(request: NextRequest) {
  const rawToken = request.nextUrl.searchParams.get('token') ?? '';

  if (rawToken.length !== 64) {
    return NextResponse.json({ valid: false, message: 'Invalid or missing reset token.' }, { status: 400 });
  }

  try {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const token = await lookupToken(tokenHash);

    if (!token) {
      return NextResponse.json({ valid: false, message: 'Invalid or expired reset link.' }, { status: 400 });
    }

    const err = validateTokenRow(token);
    if (err) {
      return NextResponse.json({ valid: false, message: err }, { status: 400 });
    }

    return NextResponse.json({ valid: true });
  } catch (error) {
    return createErrorResponse(error, 'Failed to validate reset token');
  }
}

// POST { token, password } — consume token and update password
export async function POST(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const rateLimitResponse = checkRateLimit(request, resetPasswordLimiter, 'reset-password');
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.issues[0].message }, { status: 400 });
    }

    const { token: rawToken, password } = parsed.data;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const token = await lookupToken(tokenHash);

    if (!token) {
      return NextResponse.json({ message: 'Invalid or expired reset link.' }, { status: 400 });
    }

    const err = validateTokenRow(token);
    if (err) {
      return NextResponse.json({ message: err }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await executeRawQuery(
      'UPDATE users SET password_hash = ?, modified_at = NOW() WHERE id = ?',
      [passwordHash, token.user_id]
    );

    await executeRawQuery(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?',
      [token.id]
    );

    logger.info('Password reset successful', { userId: token.user_id });
    return NextResponse.json({ message: 'Password updated successfully.' });

  } catch (error) {
    return createErrorResponse(error, 'Failed to reset password');
  }
}
