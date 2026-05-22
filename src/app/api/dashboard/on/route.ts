import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';
import { stockDataLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';

const logger = createLogger('api/dashboard/on');

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const rateLimitResponse = checkRateLimit(request, stockDataLimiter, 'dashboard-on');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get('ticker');

  if (!ticker) {
    return NextResponse.json({ message: 'Missing ticker parameter' }, { status: 400 });
  }

  const userId = session.user.id;
  const normalizedTicker = ticker.toUpperCase().trim();

  try {
    const query = `
      SELECT 
        MAX(CASE WHEN us.is_purchased = 0 AND us.user_confirmed = 1 AND us.shares > 0 AND us.is_active = 1 THEN 1 ELSE 0 END) AS onWatchlist,
        MAX(CASE WHEN us.is_purchased = 1 AND us.shares > 0 AND us.is_active = 1 THEN 1 ELSE 0 END) AS onPortfolio,
        SUM(CASE WHEN us.is_purchased = 1 AND us.is_active = 1 THEN us.shares ELSE 0 END) AS shares,
        MIN(CASE WHEN us.is_purchased = 1 AND us.is_active = 1 THEN us.initial_purchase_date ELSE NULL END) AS purchaseDate,
        MAX(CASE WHEN us.is_purchased = 1 AND us.is_active = 1 THEN us.purchase_price ELSE 0 END) AS purchasePrice
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.id
      WHERE us.user_id = ? AND s.symbol = ?;
    `;
    const [rows] = await executeRawQuery(query, [userId, normalizedTicker]);
    
    const result = (rows as any[])[0] || { onWatchlist: 0, onPortfolio: 0, shares: 0, purchaseDate: null, purchasePrice: 0 };
    const onWatchlist = result.onWatchlist === 1;
    const onPortfolio = result.onPortfolio === 1;

    return NextResponse.json({ 
      ticker: normalizedTicker, 
      onWatchlist, 
      onPortfolio,
      shares: result.shares || 0,
      purchaseDate: result.purchaseDate,
      purchasePrice: result.purchasePrice || 0
    });

  } catch (error) {
    logger.error('Error checking watchlist status', { error });
    return createErrorResponse(error, 'Failed to check watchlist status');
  }
}
