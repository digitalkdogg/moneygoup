import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/user/portfolio/summary');

// GET: Fetch portfolio summary statistics
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  const session = await getServerSession(authOptions);

  if (!session || !session.user || !session.user.id) {
    return unauthorizedResponse();
  }

  const userId = session.user.id;

  try {
    // Get all active portfolio positions
    const [positions] = await executeRawQuery(`
      SELECT
        us.shares,
        us.purchase_price
      FROM user_stocks us
      WHERE us.user_id = ? 
        AND us.is_purchased = 1 
        AND us.is_active = 1 
        AND us.shares > 0
    `, [userId]);

    if (!Array.isArray(positions) || positions.length === 0) {
      return NextResponse.json({
        total_positions: 0,
        total_invested: 0,
        total_current_value: 0,
        total_unrealized_gain: 0,
        total_unrealized_gain_pct: 0,
        best_performer: null,
        worst_performer: null,
      }, { status: 200 });
    }

    // Calculate totals
    let totalInvested = 0;
    positions.forEach((pos: any) => {
      totalInvested += parseFloat(pos.shares) * parseFloat(pos.purchase_price);
    });

    return NextResponse.json({
      total_positions: positions.length,
      total_invested: Math.round(totalInvested * 100) / 100,
      message: 'Portfolio summary retrieved successfully',
    }, { status: 200 });
  } catch (error: any) {
    logger.error('Error fetching portfolio summary:', error);
    return createErrorResponse(error, 'Error fetching portfolio summary', { status: 500 });
  }
}
