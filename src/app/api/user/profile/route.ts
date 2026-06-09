import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { getUserStrategy, isValidAggressiveness } from '@/utils/strategy';
import type { ProfileResponse } from '@/types/api';

const logger = createLogger('api/user/profile');

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return unauthorizedResponse();

  const userId = session.user.id;
  const role = ((session.user as any).role as string) ?? 'user';

  const approvalOutcome = await checkApprovalGuard(userId);
  if (!approvalOutcome.allowed) {
    logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
    return NextResponse.json(
      { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
      { status: 403 }
    );
  }

  try {
    // Fetch username from DB (not from session, which can be stale)
    const [userRows]: any[] = await executeRawQuery(
      'SELECT username FROM users WHERE id = ?',
      [userId]
    );

    const user = Array.isArray(userRows) && userRows.length > 0 ? userRows[0] : null;
    if (!user) {
      return unauthorizedResponse();
    }

    const strategy = await getUserStrategy(userId);

    if (role === 'admin') {
      const body: ProfileResponse = {
        username: user.username,
        accountType: 'admin',
        strategy,
      };
      return NextResponse.json(body, { status: 200 });
    }

    // For user / superuser: run 3 COUNT queries in parallel
    const [
      [lookupRows],
      [portfolioRows],
      [watchlistRows],
    ] = await Promise.all([
      executeRawQuery(
        'SELECT COUNT(*) AS cnt FROM user_lookup_events WHERE user_id = ?',
        [userId]
      ),
      executeRawQuery(
        'SELECT COUNT(*) AS cnt FROM user_stocks WHERE user_id = ? AND is_purchased = 1 AND is_active = 1 AND shares > 0',
        [userId]
      ),
      executeRawQuery(
        'SELECT COUNT(*) AS cnt FROM user_stocks WHERE user_id = ? AND is_purchased = 0 AND is_active = 1 AND user_confirmed = 1',
        [userId]
      ),
    ]);

    const lookupCount = Number((lookupRows as any[])[0]?.cnt ?? 0);
    const portfolioCount = Number((portfolioRows as any[])[0]?.cnt ?? 0);
    const watchlistCount = Number((watchlistRows as any[])[0]?.cnt ?? 0);

    const body: ProfileResponse = {
      username: user.username,
      accountType: role as 'user' | 'superuser',
      stats: {
        lookupCount,
        portfolioItemCount: portfolioCount,
        watchlistItemCount: watchlistCount,
      },
      strategy,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    logger.error('Error fetching user profile', { error });
    return createErrorResponse(error, 'Error fetching user profile', { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return unauthorizedResponse();

  const userId = session.user.id;

  const approvalOutcome = await checkApprovalGuard(userId);
  if (!approvalOutcome.allowed) {
    return NextResponse.json(
      { message: approvalOutcome.message, code: approvalOutcome.code },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  const aggressiveness = body?.strategy?.aggressiveness ?? body?.aggressiveness;

  if (!isValidAggressiveness(aggressiveness)) {
    return NextResponse.json(
      { message: `Invalid aggressiveness — must be one of: safe, neutral, aggressive` },
      { status: 400 }
    );
  }

  try {
    await executeRawQuery(
      `INSERT INTO user_investment_strategy (user_id, aggressiveness)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         aggressiveness = VALUES(aggressiveness)`,
      [userId, aggressiveness]
    );
    logger.info('Updated user investment strategy', { userId, aggressiveness });
    return NextResponse.json({ ok: true, strategy: { aggressiveness } }, { status: 200 });
  } catch (error) {
    logger.error('Failed to update user investment strategy', { error });
    return createErrorResponse(error, 'Failed to update strategy', { status: 500 });
  }
}
