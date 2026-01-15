import { NextRequest } from 'next/server'
import { getDbConnection } from '@/utils/db'

async function fetchFromDatabase(ticker: string) {
  let connection;
  try {
    connection = await getDbConnection()

    // Get the most recent daily price data for this ticker
    const query = `
      SELECT
        s.id,
        s.symbol,
        s.company_name,
        sdp.date,
        sdp.open,
        sdp.high,
        sdp.low,
        sdp.close,
        sdp.volume
      FROM stocks s
      LEFT JOIN (
        SELECT
          stock_id,
          MAX(date) AS max_date
        FROM stocksdailyprice
        WHERE stock_id IN (SELECT id FROM stocks WHERE symbol = ?)
        GROUP BY stock_id
      ) latest ON s.id = latest.stock_id
      LEFT JOIN stocksdailyprice sdp ON latest.stock_id = sdp.stock_id AND latest.max_date = sdp.date
      WHERE s.symbol = ?
    `

    const [rows] = await connection.execute(query, [ticker, ticker])
    await connection.end()

    if (Array.isArray(rows) && rows.length > 0) {
      const row = (rows as any[])[0]
      
      // Get previous close (previous trading day)
      let connection2;
      try {
        connection2 = await getDbConnection()
        const prevCloseQuery = `
          SELECT close FROM stocksdailyprice
          WHERE stock_id = ? AND date < ?
          ORDER BY date DESC
          LIMIT 1
        `
        const [prevRows] = await connection2.execute(prevCloseQuery, [row.id, row.date || new Date().toISOString().slice(0, 10)])
        await connection2.end()
        
        const prevClose = prevRows && (prevRows as any[])[0] ? parseFloat((prevRows as any[])[0].close) : null

        return {
          symbol: row.symbol,
          name: row.company_name,
          last: parseFloat(row.close),
          close: parseFloat(row.close),
          open: parseFloat(row.open),
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          volume: parseInt(row.volume, 10),
          prevClose: prevClose,
          timestamp: row.date,
          exchange: 'DATABASE'
        }
      } catch (error) {
        // Return without prevClose if lookup fails
        return {
          symbol: row.symbol,
          name: row.company_name,
          last: parseFloat(row.close),
          close: parseFloat(row.close),
          open: parseFloat(row.open),
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          volume: parseInt(row.volume, 10),
          timestamp: row.date,
          exchange: 'DATABASE'
        }
      }
    } else {
      throw new Error(`No data found in database for ticker ${ticker}`)
    }
  } catch (error) {
    if (connection) {
      await connection.end()
    }
    throw error
  }
}

async function fetchFromExternalAPIs(ticker: string) {
  const errors: string[] = []

  // Try Tiingo first
  try {
    const res = await fetch(`https://api.tiingo.com/iex/${ticker}?token=${process.env.TIINGO_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return data[0] || {}
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`
      errors.push(`Tiingo API: ${statusText}`)
    }
  } catch (error) {
    errors.push(`Tiingo API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // Try 12 Data if Tiingo fails
  try {
    const res = await fetch(`https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${process.env.TWELVE_DATA_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return data
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`
      errors.push(`12Data API: ${statusText}`)
    }
  } catch (error) {
    errors.push(`12Data API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // Both failed - throw error
  throw new Error(errors.join('; ') || 'Failed to fetch stock data from external APIs')
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const resolvedParams = await params;
  const ticker = resolvedParams.ticker.toUpperCase()
  const source = request.nextUrl.searchParams.get('source')

  try {
    if (source === 'dashboard') {
      // Use database for dashboard requests
      const data = await fetchFromDatabase(ticker)
      return Response.json(data)
    } else {
      // Use external APIs for direct search requests
      const data = await fetchFromExternalAPIs(ticker)
      return Response.json(data)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return Response.json(
      {
        error: source === 'dashboard' ? 'Failed to fetch stock data from database' : 'Failed to fetch stock data from external APIs',
        details: errorMessage,
        ticker: ticker,
        failedServices: source === 'dashboard' ? [] : ['Tiingo', '12Data']
      },
      { status: 500 }
    )
  }
}