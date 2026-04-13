import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';
import { DashboardRecommendation, DashboardRecommendationsResponse } from '@/types/dashboard';
 
const logger = createLogger('api/dashboard/recommendations');
 
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
      return unauthorizedResponse('Unauthorized: User ID missing from session.');
    }
 
    // 1. Fetch predictions and user stock status
    // We join with stocks to get symbols and user_stocks to get is_purchased status
    const [rows] = await executeRawQuery(`
      SELECT
        usp.stock_id,
        s.symbol,
        usp.predicted_price_1m,
        usp.last_requested_at,
        us.is_purchased
      FROM user_stock_predictions usp
      JOIN stocks s ON s.id = usp.stock_id
      JOIN user_stocks us
        ON us.user_id = usp.user_id
       AND us.stock_id = usp.stock_id
      WHERE usp.user_id = ?
      ORDER BY usp.last_requested_at DESC;
    `, [userId]);
 
    const predictions = rows as any[];
 
    if (predictions.length === 0) {
      return NextResponse.json({ recommendations: [], asOf: new Date().toISOString() });
    }
 
    // 2. Fetch current prices in batch using Yahoo Finance
    const symbols = predictions.map(p => p.symbol);
    const stockIdMap = new Map<string, number>(predictions.map(p => [p.symbol, p.stock_id]));
    
    const quotes = await fetchYahooQuotesForSymbols(symbols, stockIdMap);
    const quoteMap = new Map<number, any>();
    quotes.forEach(q => {
      if (q.stock_id !== null) {
        quoteMap.set(q.stock_id, q);
      }
    });
 
    // 3. Compute recommendations based on thresholds from environment
    const recommendations: DashboardRecommendation[] = [];
    
    const getThreshold = (envVar: string | undefined, defaultValue: number) => {
      if (!envVar) return defaultValue;
      const parsed = parseFloat(envVar);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    const portfolioPositiveThreshold = getThreshold(process.env.RECOMMENDATION_PORTFOLIO_POSITIVE_THRESHOLD, 3);
    const portfolioNegativeThreshold = getThreshold(process.env.RECOMMENDATION_PORTFOLIO_NEGATIVE_THRESHOLD, -3);
    const watchlistThreshold = getThreshold(process.env.RECOMMENDATION_WATCHLIST_THRESHOLD, 5);
 
    for (const pred of predictions) {
      const quote = quoteMap.get(pred.stock_id);
      if (!quote || quote.price === null) continue;
 
      const currentPrice = quote.price;
      const predictedPrice1m = parseFloat(pred.predicted_price_1m);
      
      // Calculate percentage difference
      const deltaPct = ((predictedPrice1m - currentPrice) / currentPrice) * 100;
 
      const isPortfolio = pred.is_purchased === 1;
      let action: 'BUY' | 'SELL' | null = null;
      if (isPortfolio) {
        // Portfolio: BUY signal at positive threshold, SELL signal at negative threshold
        if (deltaPct >= portfolioPositiveThreshold) {
          action = 'BUY';
        } else if (deltaPct <= portfolioNegativeThreshold) {
          action = 'SELL';
        }
      } else {
        // Watchlist: BUY-only signal at watchlist threshold, no SELL logic
        if (deltaPct >= watchlistThreshold) {
          action = 'BUY';
        }
      }
 
      if (action) {
        recommendations.push({
          stockId: pred.stock_id,
          symbol: pred.symbol,
          action,
          currentPrice,
          predictedPrice1m,
          deltaPct,
          lastRequestedAt: pred.last_requested_at,
          scope: isPortfolio ? 'portfolio' : 'watchlist'
        });
      }
    }
 
    // Optional: Sort by absolute delta percentage descending to show strongest signals first
    recommendations.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
 
    const response: DashboardRecommendationsResponse = {
      recommendations,
      asOf: new Date().toISOString()
    };
 
    return NextResponse.json(response);
 
  } catch (error: any) {
    logger.error("Failed to fetch dashboard recommendations.", error);
    return createErrorResponse(error, 'Failed to fetch recommendations.', { status: 500 });
  }
}