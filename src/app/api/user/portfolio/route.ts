import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/user/portfolio');

// GET: Fetch user's portfolio (all active owned positions)
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  const session = await getServerSession(authOptions);

  if (!session || !session.user || !session.user.id) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  const userId = session.user.id;

  try {
    const [portfolioItems] = await executeRawQuery(`
      SELECT
        us.user_id,
        us.stock_id,
        s.symbol,
        s.company_name,
        us.shares,
        us.purchase_price,
        us.initial_purchase_date,
        us.last_transaction_date
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.id
      WHERE us.user_id = ? 
        AND us.is_purchased = 1 
        AND us.is_active = 1 
        AND us.shares > 0
      ORDER BY us.last_transaction_date DESC
    `, [userId]);

    // Dynamically import yahoo-finance2
    const yahooFinanceModule = await import('yahoo-finance2');
    const YahooFinance = yahooFinanceModule.default;
    const yahooFinanceInstance = new YahooFinance();

    // Fetch current prices for each stock
    const portfolioWithCurrentPrices = await Promise.all(
      (portfolioItems as any[]).map(async (item) => {
        try {
          const result: any = await yahooFinanceInstance.quote(item.symbol);
          const currentPrice = result && result.regularMarketPrice ? result.regularMarketPrice : null;
          return { ...item, current_price: currentPrice };
        } catch (priceError) {
          logger.error(`Error fetching current price for ${item.symbol}:`, priceError as Error);
          return { ...item, current_price: null }; // Return null if price fetching fails
        }
      })
    );

    return NextResponse.json({ portfolio: portfolioWithCurrentPrices || [] }, { status: 200 });
  } catch (error: any) {
    logger.error('Error fetching user portfolio:', error);
    return createErrorResponse(error, 500);
  }
}

