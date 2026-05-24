import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse'
import { checkApprovalGuard } from '@/utils/approvalStatus'
import { createLogger } from '@/utils/logger'
import { getTrendingStocks } from '@/utils/yahooFinanceHelper'
import { checkOrigin } from '@/utils/originCheck'

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

  if (!isInternal) {
    const session = await getServerSession(authOptions);
    if (!session?.user) return unauthorizedResponse();
    const approvalOutcome = await checkApprovalGuard(session.user.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
  }

  try {
    const searchParams = request.nextUrl.searchParams
    const window = searchParams.get('window') || '48h'
    const limit = Math.min(parseInt(searchParams.get('limit') || '12', 10), 100)

    // Check cache
    const cacheKey = `trending_${window}_${limit}`
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
        stocks: []
      })
    }

    // Map Yahoo Finance data to our trending stocks format
    const trendingStocks = quotes.slice(0, limit).map((quote: any) => {
      // Calculate trendScore based on volume (normalized to 0-100 scale)
      const maxVolume = Math.max(...quotes.map((q: any) => q.regularMarketVolume || 0));
      const volumeScore = maxVolume > 0 ? ((quote.regularMarketVolume || 0) / maxVolume) * 100 : 0;
      
      return {
        symbol: quote.symbol,
        companyName: quote.longName || quote.shortName || 'N/A',
        price: quote.regularMarketPrice || null,
        changePercent: quote.regularMarketChangePercent || 0,
        changeAmount: quote.regularMarketChange || 0,
        marketCap: quote.marketCap || null,
        volume: quote.regularMarketVolume || 0,
        trendScore: volumeScore,
        source: 'yahoo-finance'
      }
    })

    const result = {
      window,
      generatedAt: new Date().toISOString(),
      stocks: trendingStocks
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
