import { NextRequest } from 'next/server'
import { getDbConnection } from '@/utils/db'

// Always fetch 1 year (365 days) of data from the API
// Client-side filtering will handle period selection to save API calls
const getDays = (period: string): number => {
  return 365 // Always fetch full year
}

async function fetchFromDatabase(ticker: string, startDate: string) {
  let connection;
  try {
    connection = await getDbConnection()

    // Fetch historical data from the database
    const query = `
      SELECT
        sdp.date,
        sdp.open,
        sdp.high,
        sdp.low,
        sdp.close,
        sdp.volume
      FROM stocks s
      INNER JOIN stocksdailyprice sdp ON s.id = sdp.stock_id
      WHERE s.symbol = ? AND sdp.date >= ?
      ORDER BY sdp.date ASC
    `

    const [rows] = await connection.execute(query, [ticker, startDate])
    await connection.end()

    if (Array.isArray(rows) && rows.length > 0) {
      // Transform database format to match expected response format
      const historicalData = (rows as any[]).map(row => ({
        date: row.date,
        datetime: row.date,
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseInt(row.volume, 10)
      }))
      
      return historicalData
    } else {
      throw new Error(`No historical data found in database for ticker ${ticker}`)
    }
  } catch (error) {
    if (connection) {
      await connection.end()
    }
    throw error
  }
}

async function fetchFromExternalAPIs(ticker: string, startDate: string) {
  const errors: string[] = []

  // Try Tiingo first
  try {
    const res = await fetch(`https://api.tiingo.com/tiingo/daily/${ticker}/prices?startDate=${startDate}&token=${process.env.TIINGO_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return data
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
      return data.values || []
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`
      errors.push(`12Data API: ${statusText}`)
    }
  } catch (error) {
    errors.push(`12Data API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // Both failed - throw error
  throw new Error(errors.join('; ') || 'Failed to fetch historical data from external APIs')
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string; period: string }> }
) {
  const resolvedParams = await params;
  const ticker = resolvedParams.ticker.toUpperCase();
  const period = resolvedParams.period;
  const source = request.nextUrl.searchParams.get('source')
  const days = getDays(period)
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  try {
    if (source === 'dashboard') {
      // Use database for dashboard requests
      const data = await fetchFromDatabase(ticker, startDate)
      return Response.json(data)
    } else {
      // Use external APIs for direct search requests
      const data = await fetchFromExternalAPIs(ticker, startDate)
      return Response.json(data)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return Response.json(
      {
        error: source === 'dashboard' ? 'Failed to fetch historical data from database' : 'Failed to fetch historical data from external APIs',
        details: errorMessage,
        ticker: ticker,
        period: period,
        failedServices: source === 'dashboard' ? [] : ['Tiingo', '12Data']
      },
      { status: 500 }
    )
  }
}