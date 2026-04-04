import { NextRequest, NextResponse } from 'next/server'
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper'
import { createErrorResponse } from '@/utils/errorResponse'
import { createLogger } from '@/utils/logger'
import { checkOrigin } from '@/utils/originCheck'

export const dynamic = 'force-dynamic'

const logger = createLogger('api/market/indices')

// Simple in-memory cache with TTL
const cache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  try {
    // Check cache
    const cached = cache.get('major_indices')
    const now = Date.now()
    
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      return NextResponse.json(cached.data)
    }

    // Fetch fresh data for Dow Jones, S&P 500, Nasdaq
    const symbols = ['^DJI', '^GSPC', '^IXIC']
    const emptyMap = new Map<string, number>() // No stock_id mapping needed for indices
    
    const quotes = await fetchYahooQuotesForSymbols(symbols, emptyMap)
    
    // Map to the expected response format
    const indices = [
      {
        symbol: '^DJI',
        label: 'Dow Jones',
        price: quotes.find((q: any) => q.symbol === '^DJI')?.price || null,
        change: quotes.find((q: any) => q.symbol === '^DJI')?.daily_change || null,
        changePercent: null,
        asOf: new Date().toISOString()
      },
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
        label: 'Nasdaq',
        price: quotes.find((q: any) => q.symbol === '^IXIC')?.price || null,
        change: quotes.find((q: any) => q.symbol === '^IXIC')?.daily_change || null,
        changePercent: null,
        asOf: new Date().toISOString()
      }
    ]

    // Calculate change percent
    const result = {
      indices: indices.map((idx: any) => ({
        ...idx,
        changePercent: idx.price && idx.change ? ((idx.change / (idx.price - idx.change)) * 100) : null
      }))
    }

    // Cache the result
    cache.set('major_indices', { data: result, timestamp: now })

    return NextResponse.json(result)
  } catch (error) {
    logger.error('Error fetching major indices:', { error })
    return createErrorResponse(error, 'Failed to fetch major indices', { status: 500 })
  }
}
