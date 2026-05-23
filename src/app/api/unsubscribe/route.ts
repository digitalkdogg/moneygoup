import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';

const logger = createLogger('api/unsubscribe');

const emailSchema = z.string().email();

export async function POST(request: NextRequest) {
  // RFC 8058 one-click: email comes from URL query param, body is "List-Unsubscribe=One-Click"
  // Direct call: email comes from JSON body { email }
  const { searchParams } = new URL(request.url);
  let email = searchParams.get('email');

  if (!email) {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = await request.json();
        email = body.email ?? null;
      } catch {
        return NextResponse.json({ message: 'Invalid request' }, { status: 400 });
      }
    }
  }

  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) {
    return NextResponse.json({ message: 'Valid email required' }, { status: 400 });
  }

  try {
    const [result]: any = await executeRawQuery(
      `UPDATE users SET approval_status = 'unsubscribed' WHERE email = ?`,
      [parsed.data]
    );

    if (result.affectedRows === 0) {
      // Don't reveal whether the email exists — just return 200
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
