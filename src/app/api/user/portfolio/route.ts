import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/user/portfolio');

// GET: Fetch user's portfolio (all active owned positions)
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  const session = await getServerSession(authOptions);

  if (!session || !session.user || !session.user.id) {
    return unauthorizedResponse();
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
          const quoteResult = await yahooFinanceInstance.quote(item.symbol);
          const currentPrice = (quoteResult as any)?.regularMarketPrice || null;
          let prevClose = null;

          // Try to get previous close from quote first
          const quotePrevClose = (quoteResult as any)?.regularMarketPreviousClose;
          if (quotePrevClose) {
            prevClose = quotePrevClose;
          } else {
            // Fallback to historical data if not available in quote
            try {
              const historicalResult = await yahooFinanceInstance.historical(item.symbol, {
                period1: new Date(Date.now() - 86400000 * 7).toISOString().split('T')[0], // 7 days ago
                period2: new Date().toISOString().split('T')[0] // Today
              });

              if (historicalResult && historicalResult.length > 0) {
                // Find the most recent previous trading day closing price
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                // Sort by date descending (most recent first)
                const sortedByDate = [...historicalResult].sort((a, b) =>
                  new Date(b.date).getTime() - new Date(a.date).getTime()
                );

                // Find the first data point that is before today
                for (const dataPoint of sortedByDate) {
                  const dataPointDate = new Date(dataPoint.date);
                  dataPointDate.setHours(0, 0, 0, 0);
                  if (dataPointDate.getTime() < today.getTime()) {
                    prevClose = dataPoint.close;
                    break;
                  }
                }
              }
            } catch (histError) {
              logger.warn(`Could not fetch historical data for ${item.symbol}`);
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

