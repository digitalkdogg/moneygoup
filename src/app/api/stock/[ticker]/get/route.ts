import { NextRequest, NextResponse } from 'next/server'
import { checkOrigin } from '@/utils/originCheck'
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators'

export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const originCheckResponse = checkOrigin(request)
  if (originCheckResponse) return originCheckResponse

  const ticker = params.ticker.toUpperCase()

  const origin = request.nextUrl?.origin || ''

  try {
    const stockPromise = fetch(`${origin}/api/stock/${ticker}`)
    const newsPromise = fetch(`${origin}/api/stock/${ticker}/news`)
    const histPromise = fetch(`${origin}/api/stock/${ticker}/historical/1Y`)

    const [stockRes, newsRes, histRes] = await Promise.all([stockPromise, newsPromise, histPromise])

    const stockJson = stockRes.ok ? await stockRes.json() : { error: `Failed to fetch stock: ${stockRes.status}` }
    const newsJson = newsRes.ok ? await newsRes.json() : { error: `Failed to fetch news: ${newsRes.status}` }
    const histJson = histRes.ok ? await histRes.json() : { error: `Failed to fetch historical: ${histRes.status}` }

    const indicators = histRes.ok && newsRes.ok && stockRes.ok
      ? calculateTechnicalIndicators(
          histJson.historicalData,
          newsJson.articles || [],
          stockJson?.peRatio,
          stockJson?.pbRatio,
          stockJson?.marketCap
        )
      : null

    return NextResponse.json({ stock: stockJson, news: newsJson, historical: histJson, indicators })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch consolidated stock data', details: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
