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

async function fetchMacroContext(): Promise<any> {
    try {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
        const res = await fetch(`${baseUrl}/api/worldbank`, {
            headers: { 'x-api-key': internalSecret || '' }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        logger.warn('Failed to fetch macro context for recommendations', { error: err });
        return null;
    }
}
 
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
 
    // 1. Fetch predictions and user stock status with extended flags
    const [rows] = await executeRawQuery(`
      SELECT
        usp.stock_id,
        s.symbol,
        usp.predicted_price_1m,
        COALESCE(sgs.gps_score, rs.gps_score) as gps_score,
        COALESCE(sgs.gps_breakdown, rs.gps_breakdown) as gps_breakdown,
        usp.last_requested_at,
        us.is_purchased,
        us.user_confirmed,
        us.shares,
        us.is_active
      FROM user_stock_predictions usp
      JOIN stocks s ON s.id = usp.stock_id
      JOIN user_stocks us
        ON us.user_id = usp.user_id
       AND us.stock_id = usp.stock_id
      LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = usp.stock_id
      LEFT JOIN (
        SELECT ticker, MAX(gps_score) as gps_score, MAX(gps_breakdown) as gps_breakdown
        FROM recommended_stocks
        GROUP BY ticker
      ) rs ON s.symbol = rs.ticker
      WHERE usp.user_id = ? AND us.is_active = 1
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

    const basePortfolioPositiveThreshold = getThreshold(process.env.RECOMMENDATION_PORTFOLIO_POSITIVE_THRESHOLD, 3);
    const portfolioNegativeThreshold = getThreshold(process.env.RECOMMENDATION_PORTFOLIO_NEGATIVE_THRESHOLD, -3);
    const baseWatchlistThreshold = getThreshold(process.env.RECOMMENDATION_WATCHLIST_THRESHOLD, 5);

    // --- Macro Dampeners (Phase 3) ---
    const macroContext = await fetchMacroContext();
    const unemployment = macroContext?.macro?.indicators?.unemployment;
    const globalHealth = macroContext?.risk_index?.globalHealthScore;

    let buyDampener = 0; // percentage points to ADD to required threshold
    let globalModifier = 1.0; // GPS/Confidence multiplier

    if (unemployment && unemployment.signal === 'bearish') {
        // Unemployment is rising (bearish for economy)
        buyDampener = 2.0; 
        logger.info('Applying unemployment dampener to BUY thresholds', { delta: unemployment.delta });
    }

    if (globalHealth !== undefined && globalHealth !== null) {
        if (globalHealth > 70) globalModifier = 1.05;
        else if (globalHealth < 45) globalModifier = 0.90;
    }

    const portfolioPositiveThreshold = basePortfolioPositiveThreshold + buyDampener;
    const watchlistThreshold = baseWatchlistThreshold + buyDampener;
 
    for (const pred of predictions) {
      const quote = quoteMap.get(pred.stock_id);
      if (!quote || quote.price === null) continue;
 
      const currentPrice = quote.price;
      const predictedPrice1m = parseFloat(pred.predicted_price_1m);
      
      // Calculate percentage difference
      let deltaPct = ((predictedPrice1m - currentPrice) / currentPrice) * 100;

      // Apply global health modifier to prediction for international context
      if (globalModifier !== 1.0) {
          deltaPct *= globalModifier;
      }
 
      const isConfirmed = pred.user_confirmed === 1;
      const isPurchased = pred.is_purchased === 1;
      const hasShares = pred.shares > 0;

      let action: 'BUY' | 'SELL' | null = null;
      let scope: 'portfolio' | 'watchlist' | 'discovery' | null = null;

      if (isPurchased && isConfirmed && hasShares) {
        // Bucket 1: Portfolio (Must have shares)
        scope = 'portfolio';
        if (deltaPct >= portfolioPositiveThreshold) {
          action = 'BUY';
        } else if (deltaPct <= portfolioNegativeThreshold) {
          action = 'SELL';
        }
      } else if (!isPurchased && isConfirmed) {
        // Bucket 2: Watchlist (Confirmed by user, 0 shares allowed)
        scope = 'watchlist';
        if (deltaPct >= watchlistThreshold) {
          action = 'BUY';
        }
      } else if (!isPurchased && !isConfirmed) {
        // Bucket 3: Discovery (Unconfirmed items, 0 shares allowed)
        scope = 'discovery';
        if (deltaPct >= watchlistThreshold) {
          action = 'BUY';
        }
      }
 
      if (action && scope) {
        recommendations.push({
          stockId: pred.stock_id,
          symbol: pred.symbol,
          action,
          currentPrice,
          predictedPrice1m,
          deltaPct,
          gpsScore: pred.gps_score !== null ? parseFloat(pred.gps_score) : null,
          gpsBreakdown: pred.gps_breakdown ? (typeof pred.gps_breakdown === 'string' ? JSON.parse(pred.gps_breakdown) : pred.gps_breakdown) : null,
          lastRequestedAt: pred.last_requested_at,
          scope
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
    logger.error("Failed to fetch dashboard recommendations.", { error });
    return createErrorResponse(error, 'Failed to fetch recommendations.', { status: 500 });
  }
}
