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
          const [quoteResult, historicalResult] = await Promise.all([
            yahooFinanceInstance.quote(item.symbol),
            yahooFinanceInstance.historical(item.symbol, { 
                period1: new Date(Date.now() - 86400000 * 3).toISOString().split('T')[0], // 3 days ago
                period2: new Date().toISOString().split('T')[0] // Today
            })
          ]);
          
          const currentPrice = (quoteResult as any)?.regularMarketPrice || null;
          let prevClose = null;

          if (historicalResult && historicalResult.length >= 2) {
            // Find the most recent historical data that is not today's date
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Normalize today's date to avoid time comparison issues

            // Find the data for the previous trading day
            let previousTradingDayData = null;
            for (const dataPoint of historicalResult) {
                const dataPointDate = new Date(dataPoint.date);
                dataPointDate.setHours(0, 0, 0, 0);
                // Ensure it's not today's date and that it's a valid trading day
                if (dataPointDate.getTime() < today.getTime()) {
                    previousTradingDayData = dataPoint;
                    break;
                }
            }

            if (previousTradingDayData) {
                prevClose = previousTradingDayData.close;
            }

          } else if (historicalResult && historicalResult.length === 1) {
             const dataPointDate = new Date(historicalResult[0].date);
             const today = new Date();
             today.setHours(0, 0, 0, 0);
             if (dataPointDate.getTime() < today.getTime()) {
                 prevClose = historicalResult[0].close;
             }
          }
          
          return { ...item, regularMarketPrice: currentPrice, prev_close: prevClose };
        } catch (priceError) {
          logger.error(`Error fetching data for ${item.symbol}:`, priceError as Error);
          return { ...item, regularMarketPrice: null, prev_close: null };
        }
      })
    );

    return NextResponse.json({ portfolio: portfolioWithCurrentPrices || [] }, { status: 200 });
  } catch (error: any) {
    logger.error('Error fetching user portfolio:', error);
    return createErrorResponse(error, 'Error fetching user portfolio', { status: 500 });
  }
}

