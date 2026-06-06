import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';
import { DashboardRecommendation, DashboardRecommendationsResponse } from '@/types/dashboard';

const logger = createLogger('api/dashboard/recommendations');

async function fetchMacroContext(): Promise<Record<string, unknown> | null> {
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

function getEnvThreshold(key: string, fallback: number): number {
  const val = process.env[key]
  if (!val) return fallback
  const parsed = parseFloat(val)
  return isNaN(parsed) ? fallback : parsed
}

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session) return unauthorizedResponse();

  try {
    const userId = session.user?.id;
    if (!userId) return unauthorizedResponse('Unauthorized: User ID missing from session.');

    const approvalOutcome = await checkApprovalGuard(userId);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }

    // 1. Fetch predictions with GPS scores
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

    const predictions = rows as Record<string, unknown>[];

    // 1b. Fetch ETF holding recommendations (last 7 days)
    const [etfRecRows] = await executeRawQuery(
      `SELECT stock_ticker, etf_ticker, gps_score, predicted_change_pct, confidence_score, created_at
       FROM etf_stock_recommendations
       WHERE user_id = ? AND created_at >= NOW() - INTERVAL 7 DAY
       ORDER BY gps_score DESC`,
      [userId]
    );
    const etfRecs = etfRecRows as Record<string, unknown>[];

    if (predictions.length === 0 && etfRecs.length === 0) {
      return NextResponse.json({ recommendations: [], asOf: new Date().toISOString() });
    }

    // 2. Fetch current prices in batch — include ETF holding tickers so cards show live price
    const predSymbols = predictions.map(p => p.symbol as string);
    const etfHoldingSymbols = [...new Set(etfRecs.map(r => r.stock_ticker as string))];
    const allSymbols = [...new Set([...predSymbols, ...etfHoldingSymbols])];
    const stockIdMap = new Map<string, number>(predictions.map(p => [p.symbol as string, p.stock_id as number]));
    const quotes = await fetchYahooQuotesForSymbols(allSymbols, stockIdMap);
    const quoteMap = new Map<number, Record<string, unknown>>();
    const symbolPriceMap = new Map<string, number>();
    quotes.forEach(q => {
      if (q.stock_id !== null) quoteMap.set(q.stock_id as number, q as Record<string, unknown>);
      if (q.symbol && q.price !== null) symbolPriceMap.set(q.symbol as string, q.price as number);
    });

    // 3. GPS thresholds from env
    const buyThreshold       = getEnvThreshold('GPS_RECOMMENDATION_BUY_THRESHOLD', 65);
    const sellThreshold      = getEnvThreshold('GPS_RECOMMENDATION_SELL_THRESHOLD', 45);
    const discoveryThreshold = getEnvThreshold('GPS_RECOMMENDATION_DISCOVERY_THRESHOLD', 70);

    // 4. Macro GPS adjustment (±3 pts max)
    const macroContext = await fetchMacroContext();
    const unemployment = (macroContext?.macro as Record<string, unknown> | undefined)
      ?.indicators as Record<string, unknown> | undefined;
    const unemploymentSignal = (unemployment?.unemployment as Record<string, unknown> | undefined)?.signal as string | undefined;
    const globalHealth = (macroContext?.risk_index as Record<string, unknown> | undefined)
      ?.globalHealthScore as number | undefined;

    let macroGpsAdjustment = 0;
    if (unemploymentSignal === 'bearish') {
      macroGpsAdjustment -= 2;
      logger.info('Applying unemployment macro dampener to GPS scores', { adjustment: -2 });
    }
    if (globalHealth != null) {
      if (globalHealth > 70) macroGpsAdjustment += 1.5;
      else if (globalHealth < 45) macroGpsAdjustment -= 3;
    }
    macroGpsAdjustment = Math.max(-3, Math.min(3, macroGpsAdjustment));

    // 5. Build recommendations
    const recommendations: DashboardRecommendation[] = [];

    for (const pred of predictions) {
      const quote = quoteMap.get(pred.stock_id as number);
      if (!quote || quote.price === null) continue;

      const currentPrice    = quote.price as number;
      const predictedPrice1m = parseFloat(String(pred.predicted_price_1m));
      const deltaPct        = ((predictedPrice1m - currentPrice) / currentPrice) * 100;

      const rawGps       = pred.gps_score != null ? parseFloat(String(pred.gps_score)) : null;
      const adjustedGps  = rawGps != null ? rawGps + macroGpsAdjustment : null;

      const isConfirmed  = pred.user_confirmed === 1;
      const isPurchased  = pred.is_purchased === 1;
      const hasShares    = (pred.shares as number) > 0;

      let action: 'BUY' | 'SELL' | null = null;
      let scope: DashboardRecommendation['scope'] | null = null;

      if (adjustedGps === null) continue;

      if (isPurchased && isConfirmed && hasShares) {
        scope = 'portfolio';
        if (adjustedGps >= buyThreshold) action = 'BUY';
        else if (adjustedGps < sellThreshold) action = 'SELL';
      } else if (!isPurchased && isConfirmed) {
        scope = 'watchlist';
        if (adjustedGps >= buyThreshold) action = 'BUY';
      } else if (!isPurchased && !isConfirmed) {
        scope = 'discovery';
        if (adjustedGps >= discoveryThreshold) action = 'BUY';
      }

      if (action && scope) {
        recommendations.push({
          stockId:        pred.stock_id as number,
          symbol:         pred.symbol as string,
          action,
          currentPrice,
          predictedPrice1m,
          deltaPct,
          gpsScore:       rawGps,
          gpsBreakdown:   pred.gps_breakdown
            ? (typeof pred.gps_breakdown === 'string' ? JSON.parse(pred.gps_breakdown) : pred.gps_breakdown)
            : null,
          lastRequestedAt: pred.last_requested_at as string,
          scope,
        });
      }
    }

    // 6. Merge ETF holding recommendations — deduplicate against symbols already present
    const existingSymbols = new Set(recommendations.map(r => r.symbol));
    const seenEtfTickers = new Set<string>();
    for (const rec of etfRecs) {
      const symbol = (rec.stock_ticker as string).toUpperCase();
      // Skip if this ticker already has a portfolio/watchlist/discovery card
      if (existingSymbols.has(symbol)) continue;
      // Deduplicate: one card per stock ticker (keep highest GPS, already ordered DESC)
      if (seenEtfTickers.has(symbol)) continue;
      seenEtfTickers.add(symbol);

      const gps = rec.gps_score != null ? parseFloat(String(rec.gps_score)) : null;
      if (gps === null) continue;

      const currentPrice = symbolPriceMap.get(symbol) ?? 0;
      const predChangePct = rec.predicted_change_pct != null ? parseFloat(String(rec.predicted_change_pct)) : 0;
      const predictedPrice1m = currentPrice > 0 ? currentPrice * (1 + predChangePct / 100) : 0;

      recommendations.push({
        stockId:         0,
        symbol,
        action:          'BUY',
        currentPrice,
        predictedPrice1m,
        deltaPct:        predChangePct,
        gpsScore:        gps,
        gpsBreakdown:    null,
        lastRequestedAt: rec.created_at as string,
        scope:           'etf_holding',
        etfTicker:       (rec.etf_ticker as string).toUpperCase(),
      });
    }

    // Sort by GPS score descending — strongest signals first
    recommendations.sort((a, b) => (b.gpsScore ?? 0) - (a.gpsScore ?? 0));

    const response: DashboardRecommendationsResponse = {
      recommendations,
      asOf: new Date().toISOString(),
    };

    return NextResponse.json(response);

  } catch (error: unknown) {
    logger.error('Failed to fetch dashboard recommendations.', { error });
    return createErrorResponse(error, 'Failed to fetch recommendations.', { status: 500 });
  }
}
