import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';
import { unsubscribeLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';

const logger = createLogger('api/unsubscribe');

const emailSchema = z.string().email();

function verifyToken(email: string, token: string): boolean {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not configured — cannot verify unsubscribe tokens');
  const expected = createHmac('sha256', secret).update(email).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, unsubscribeLimiter, 'unsubscribe');
  if (rateLimitResponse) return rateLimitResponse;

  // RFC 8058: email and token must come from URL query params.
  // Gmail's one-click POST body only contains "List-Unsubscribe=One-Click",
  // so all identifying information must be in the URL.
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  const token = searchParams.get('token');

  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) {
    return NextResponse.json({ message: 'Valid email required' }, { status: 400 });
  }

  if (!token || !verifyToken(parsed.data, token)) {
    logger.warn('Unsubscribe: invalid or missing token', { email: parsed.data });
    // Return 200 so email clients don't retry — but don't act on the request
    return new NextResponse('OK', { status: 200 });
  }

  try {
    const [result]: any = await executeRawQuery(
      `UPDATE users SET approval_status = 'unsubscribed' WHERE email = ?`,
      [parsed.data]
    );

    if (result.affectedRows === 0) {
      logger.info('Unsubscribe: email not found', { email: parsed.data });
    } else {
      logger.info('User unsubscribed', { email: parsed.data });
    }

    return new NextResponse('OK', { status: 200 });
  } catch (error) {
    logger.error('Unsubscribe failed', { email: parsed.data, error });
    return NextResponse.json({ message: 'Internal error' }, { status: 500 });
  }
}
