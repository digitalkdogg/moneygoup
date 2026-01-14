import { NextRequest } from 'next/server'

// Always fetch 1 year (365 days) of data from the API
// Client-side filtering will handle period selection to save API calls
const getDays = (period: string): number => {
  return 365 // Always fetch full year
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string; period: string }> }
) {
  const resolvedParams = await params;
  const ticker = resolvedParams.ticker.toUpperCase();
  const period = resolvedParams.period;
  const days = getDays(period)
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const errors: string[] = []

  // Try Tiingo first
  try {
    const res = await fetch(`https://api.tiingo.com/tiingo/daily/${ticker}/prices?startDate=${startDate}&token=${process.env.TIINGO_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return Response.json(data)
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`
      errors.push(`Tiingo API: ${statusText}`)
    }
  } catch (error) {
    errors.push(`Tiingo API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // Try 12Data if Tiingo fails
  try {
    const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&start_date=${startDate}&apikey=${process.env.TWELVE_DATA_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      // 12 Data returns { meta, values }, values is array of { datetime, open, high, low, close, volume }
      return Response.json(data.values || [])
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`
      errors.push(`12Data API: ${statusText}`)
    }
  } catch (error) {
    errors.push(`12Data API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // Both failed - return detailed error
  return Response.json(
    {
      error: 'Failed to fetch historical data from both providers',
      details: errors.join('; '),
      ticker: ticker,
      period: period,
      failedServices: ['Tiingo', '12Data']
    },
    { status: 500 }
  )
}