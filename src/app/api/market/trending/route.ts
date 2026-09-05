import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse'
import { checkApprovalGuard } from '@/utils/approvalStatus'
import { createLogger } from '@/utils/logger'
import { getTrendingStocks, fetchYahooStockSummary } from '@/utils/yahooFinanceHelper'
import { checkOrigin } from '@/utils/originCheck'
import { executeRawQuery } from '@/utils/databaseHelper'
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy'
import { adjustGpsForHorizon } from '@/utils/gps'
import { normalizeRecommendation } from '@/utils/formatters'

export const dynamic = 'force-dynamic'

const logger = createLogger('api/market/trending')

// Simple in-memory cache with TTL
const cache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 15 * 60 * 1000 // 15 minutes

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = internalSecret && apiKey === internalSecret;

  let userId: number | string | null = null;
  if (!isInternal) {
    const session = await getServerSession(authOptions);
    if (!session?.user) return unauthorizedResponse();
    const approvalOutcome = await checkApprovalGuard(session.user.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
    userId = session.user.id;
  }

  try {
    const searchParams = request.nextUrl.searchParams
    const window = searchParams.get('window') || '48h'
    const limit = Math.min(parseInt(searchParams.get('limit') || '12', 10), 100)

    // Resolve the user's investment_timeframe so the enriched cards report
    // horizon-aware predicted prices + GPS that matches the dashboard view.
    // For internal callers we skip enrichment entirely.
    const userStrategy = userId != null
      ? await getUserStrategy(userId).catch(() => DEFAULT_STRATEGY)
      : DEFAULT_STRATEGY;
    const timeframeConfig = resolveStrategy(userStrategy).timeframe;
    const priceColumn = timeframeConfig.predictedPriceColumn;
    const sfx = priceColumn.replace('predicted_price_', ''); // '1w' | '1m' | '6m' | '1y'
    const horizonLabel = timeframeConfig.shortLabel;

    // Cache key is per (user, horizon) so different timeframes don't collide.
    const cacheKey = `trending_${userId ?? 'internal'}_${horizonLabel}_${window}_${limit}`
    const cached = cache.get(cacheKey)
    const now = Date.now()

    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      logger.info('Returning cached trending stocks')
      return NextResponse.json(cached.data)
    }

    // Fetch trending stocks from Yahoo Finance
    logger.info('Fetching trending stocks from Yahoo Finance', { window, limit })

    const quotes = await getTrendingStocks(limit * 2)
    logger.info('Fetched quotes from Yahoo Finance', { count: quotes.length })

    if (!Array.isArray(quotes) || quotes.length === 0) {
      logger.warn('No trending stocks available from Yahoo Finance')
      return NextResponse.json({
        window,
        generatedAt: new Date().toISOString(),
        horizonLabel,
        stocks: []
      })
    }

    const topQuotes = quotes.slice(0, limit);
    const symbols = topQuotes.map((q: any) => q.symbol).filter(Boolean);

    // Pull prediction + GPS rows for the trending symbols in a single batch.
    // user_stock_predictions is per-user; for internal callers (no userId) the
    // join yields no rows and predictions/GPS stay null.
    const enrichmentRows: Record<string, any> = {};
    if (symbols.length > 0) {
      const placeholders = symbols.map(() => '?').join(',');
      const params: (string | number)[] = [...symbols];
      let predictionJoin = '';
      if (userId != null) {
        predictionJoin = `LEFT JOIN user_stock_predictions usp
          ON usp.stock_id = s.id AND usp.user_id = ?`;
        params.unshift(userId);
      }
      const rows = (await executeRawQuery(`
        SELECT
          s.id AS stock_id,
          s.symbol,
          ${userId != null ? `usp.predicted_price_1m,
          COALESCE(usp.${priceColumn}, usp.predicted_price_1m) AS predicted_price_horizon,
          usp.predicted_change_pct_${sfx} AS predicted_change_pct_horizon,
          usp.confidence_score_${sfx} AS confidence_score_horizon,` : `
          NULL AS predicted_price_1m,
          NULL AS predicted_price_horizon,
          NULL AS predicted_change_pct_horizon,
          NULL AS confidence_score_horizon,`}
          sgs.gps_score,
          sgs.gps_breakdown
        FROM stocks s
        ${predictionJoin}
        LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
        WHERE s.symbol IN (${placeholders})
      `, params))[0] as any[];
      for (const row of rows) {
        enrichmentRows[row.symbol] = row;
      }
    }

    // Helper: average of the last 120 daily closes ≈ 6-month MA.
    const maForStock = async (stockId: number | null): Promise<number | null> => {
      if (stockId == null) return null;
      try {
        const [dailyPrices] = await executeRawQuery(`
          SELECT close
          FROM stocksdailyprice
          WHERE stock_id = ?
          ORDER BY date DESC
          LIMIT 120
        `, [stockId]) as any[];
        if (!Array.isArray(dailyPrices) || dailyPrices.length === 0) return null;
        const sum = dailyPrices.reduce((acc: number, p: any) => acc + parseFloat(p.close), 0);
        return sum / dailyPrices.length;
      } catch {
        return null;
      }
    };

    const maxVolume = Math.max(...topQuotes.map((q: any) => q.regularMarketVolume || 0));

    const trendingStocks = await Promise.all(topQuotes.map(async (quote: any) => {
      const volumeScore = maxVolume > 0 ? ((quote.regularMarketVolume || 0) / maxVolume) * 100 : 0;
      const enrich = enrichmentRows[quote.symbol];

      // GPS: prefer the cached baseline patched by adjustGpsForHorizon using the
      // model's stored per-horizon change% + confidence (same path as the dashboard).
      let gpsScore: number | null = null;
      let gpsBreakdown: any = null;
      if (enrich?.gps_score != null) {
        gpsScore = parseFloat(enrich.gps_score);
        const baselineBreakdown = enrich.gps_breakdown
          ? (typeof enrich.gps_breakdown === 'string' ? JSON.parse(enrich.gps_breakdown) : enrich.gps_breakdown)
          : null;
        gpsBreakdown = baselineBreakdown;
        if (baselineBreakdown) {
          const storedChangePct = enrich.predicted_change_pct_horizon != null
            ? parseFloat(enrich.predicted_change_pct_horizon) : null;
          const storedConfidence = enrich.confidence_score_horizon != null
            ? parseFloat(enrich.confidence_score_horizon) : undefined;
          const horizonPrice = enrich.predicted_price_horizon != null
            ? parseFloat(enrich.predicted_price_horizon) : null;
          const currentPrice = quote.regularMarketPrice || null;
          let changePct: number | null = storedChangePct;
          if (changePct == null && currentPrice && horizonPrice && currentPrice > 0) {
            changePct = ((horizonPrice - currentPrice) / currentPrice) * 100;
          }
          if (changePct != null) {
            const adjusted = adjustGpsForHorizon(baselineBreakdown, changePct, storedConfidence, userStrategy.investment_timeframe);
            gpsScore = adjusted.score;
            gpsBreakdown = adjusted.breakdown;
          }
        }
      }

      // Analyst data + MA in parallel.
      const [summary, ma6m] = await Promise.all([
        fetchYahooStockSummary(quote.symbol).catch(() => null),
        maForStock(enrich?.stock_id ?? null),
      ]);

      return {
        symbol: quote.symbol,
        companyName: quote.longName || quote.shortName || 'N/A',
        price: quote.regularMarketPrice || null,
        changePercent: quote.regularMarketChangePercent || 0,
        changeAmount: quote.regularMarketChange || 0,
        marketCap: quote.marketCap || null,
        volume: quote.regularMarketVolume || 0,
        trendScore: volumeScore,
        gpsScore,
        gpsBreakdown,
        analystFeedback: normalizeRecommendation(summary?.financialData?.recommendationKey ?? null),
        analysts: summary?.financialData?.numberOfAnalystOpinions ?? null,
        ma6m,
        predictedPriceHorizon: enrich?.predicted_price_horizon != null
          ? parseFloat(enrich.predicted_price_horizon) : null,
        source: 'yahoo-finance',
      }
    }))

    const result = {
      window,
      generatedAt: new Date().toISOString(),
      horizonLabel,
      stocks: trendingStocks,
    }

    // Cache the result
    cache.set(cacheKey, { data: result, timestamp: now })
    logger.info('Cached trending stocks result', { cacheKey })

    return NextResponse.json(result)
  } catch (error) {
    logger.error('Error fetching trending stocks:', { error })
    return createErrorResponse(error, 'Failed to fetch trending stocks', { status: 500 })
  }
}
