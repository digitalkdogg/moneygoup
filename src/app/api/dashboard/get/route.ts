import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';

const logger = createLogger('api/dashboard/get');

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  const session = await getServerSession(authOptions);

  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const userId = session.user?.id;
    if (!userId) {
      logger.error('Session user ID is undefined or null for an authenticated session.');
      return unauthorizedResponse('Unauthorized: User ID missing or invalid from session.');
    }

    // 1. Fetch all stock symbols the user is tracking
    const [userStocksResult] = await executeRawQuery(`
        SELECT
            s.symbol,
            s.id AS stock_id
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.id
        WHERE us.user_id = ?
        ORDER BY s.symbol;
    `, [userId]);

    const userStocks = userStocksResult as { symbol: string; stock_id: number }[];
    const symbols = userStocks.map(stock => stock.symbol);
    const stockIdMap = new Map<string, number>(userStocks.map(stock => [stock.symbol, stock.stock_id]));

    const combinedData = await fetchYahooQuotesForSymbols(symbols, stockIdMap);

    return NextResponse.json(combinedData);

  } catch (error: any) {
    logger.error("Failed to fetch dashboard data from Yahoo Finance.", error);
    return createErrorResponse(error, 'Failed to fetch dashboard data from Yahoo Finance.', { status: 500 });
  }
}
