import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import { normalizeRecommendation } from '@/utils/formatters';
import { analystRatingsCache } from '@/utils/cache';

const logger = createLogger('api/dashboard/analyst-ratings');

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
    // Check cache
    const cached = analystRatingsCache.get(`analyst_ratings_${userId}`)
    
    if (cached) {
      return NextResponse.json(cached)
    }

    // Get symbols held by the user
    const [holdings] = await executeRawQuery(`
      SELECT DISTINCT s.symbol
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.id
      WHERE us.user_id = ? 
        AND us.is_purchased = 1 
        AND us.is_active = 1 
        AND us.shares > 0
    `, [userId]);

    const symbols = (holdings as any[]).map(h => h.symbol);

    if (symbols.length === 0) {
      const result = { ratings: [], asOf: new Date().toISOString() };
      analystRatingsCache.set(`analyst_ratings_${userId}`, result)
      return NextResponse.json(result);
    }

    // Fetch analyst data for each symbol
    const ratings = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const summary = await fetchYahooStockSummary(symbol);
          return {
            symbol,
            primary: normalizeRecommendation(summary.financialData?.recommendationKey),
            score: summary.financialData?.recommendationMean || null,
            count: summary.financialData?.numberOfAnalystOpinions || null
          };
        } catch (error) {
          logger.warn(`Error fetching analyst data for ${symbol}:`, { error: error instanceof Error ? error.message : String(error) });
          return {
            symbol,
            primary: 'Unknown',
            score: null,
            count: null
          };
        }
      })
    );

    const result = {
      ratings: ratings.filter(r => r.symbol !== null),
      asOf: new Date().toISOString()
    };

    // Cache the result
    analystRatingsCache.set(`analyst_ratings_${userId}`, result)

    return NextResponse.json(result);
  } catch (error) {
    logger.error('Error in analyst ratings dashboard API:', { error: error instanceof Error ? error.message : String(error) });
    return createErrorResponse(error, 'Failed to fetch analyst ratings', { status: 500 });
  }
}
