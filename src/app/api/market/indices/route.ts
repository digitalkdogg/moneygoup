import { NextRequest, NextResponse } from 'next/server'
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper'
import { createErrorResponse } from '@/utils/errorResponse'
import { createLogger } from '@/utils/logger'
import { checkOrigin } from '@/utils/originCheck'
import { marketIndicesCache } from '@/utils/cache'

export const dynamic = 'force-dynamic'

const logger = createLogger('api/market/indices')

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  try {
    // Check cache
    const cached = marketIndicesCache.get('major_indices')
    
    if (cached) {
      return NextResponse.json(cached)
    }

    // Fetch fresh data for Dow Jones, S&P 500, Nasdaq, VIX
    const symbols = ['^DJI', '^GSPC', '^IXIC', '^VIX']
    const emptyMap = new Map<string, number>() // No stock_id mapping needed for indices
    
    const quotes = await fetchYahooQuotesForSymbols(symbols, emptyMap)
    
    // Map to the expected response format
    const indices = [
      {
        symbol: '^GSPC',
        label: 'S&P 500',
        price: quotes.find((q: any) => q.symbol === '^GSPC')?.price || null,
        change: quotes.find((q: any) => q.symbol === '^GSPC')?.daily_change || null,
        changePercent: null,
        asOf: new Date().toISOString()
      },
      {
        symbol: '^IXIC',
        label: 'NASDAQ',
        price: quotes.find((q: any) => q.symbol === '^IXIC')?.price || null,
        change: quotes.find((q: any) => q.symbol === '^IXIC')?.daily_change || null,
        changePercent: null,
        asOf: new Date().toISOString()
      },
      {
        symbol: '^DJI',
        label: 'DOW',
        price: quotes.find((q: any) => q.symbol === '^DJI')?.price || null,
        change: quotes.find((q: any) => q.symbol === '^DJI')?.daily_change || null,
        changePercent: null,
        asOf: new Date().toISOString()
      },
      {
        symbol: '^VIX',
        label: 'VIX',
        price: quotes.find((q: any) => q.symbol === '^VIX')?.price || null,
        change: quotes.find((q: any) => q.symbol === '^VIX')?.daily_change || null,
        changePercent: null,
        asOf: new Date().toISOString()
      }
    ]

    // Calculate change percent
    const result = {
      indices: indices.map((idx: any) => ({
        ...idx,
        changePercent: idx.price && idx.change ? ((idx.change / (idx.price - idx.change)) * 100) : null
      })),
      asOf: new Date().toISOString()
    }

    // Cache the result
    marketIndicesCache.set('major_indices', result)

    return NextResponse.json(result)
  } catch (error) {
    logger.error('Error fetching major indices:', { error })
    return createErrorResponse(error, 'Failed to fetch major indices', { status: 500 })
  }
}
