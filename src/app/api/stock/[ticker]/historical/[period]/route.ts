import { NextRequest } from 'next/server'
import { getDbConnection } from '@/utils/db'
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

const getDays = (period: string): number => {
  switch (period) {
    case '1w':
      return 7;
    case '1m':
      return 30;
    case '6m':
      return 180;
    case '1y':
      return 365;
    default:
      return 365;
  }
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
        sdp.volume,
        sdp.adj_open,
        sdp.adj_high,
        sdp.adj_low,
        sdp.adj_close,
        sdp.adj_volume
      FROM stocks s
      INNER JOIN stocksdailyprice sdp ON s.id = sdp.stock_id
      WHERE s.symbol = ? AND sdp.date >= ?
      ORDER BY sdp.date ASC
    `

    const [rows] = await connection.execute(query, [ticker, startDate])
    await connection.release()

    if (Array.isArray(rows) && rows.length > 0) {
      // Transform database format to match expected response format
      const historicalData = (rows as any[]).map(row => ({
        date: row.date,
        datetime: row.date,
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseInt(row.volume, 10),
        adjOpen: parseFloat(row.adj_open),
        adjHigh: parseFloat(row.adj_high),
        adjLow: parseFloat(row.adj_low),
        adjClose: parseFloat(row.adj_close),
        adjVolume: parseInt(row.adj_volume, 10)
      }))
      
      return {
        historicalData: historicalData,
        source: ['DATABASE']
      }
    } else {
      throw new Error(`No historical data found in database for ticker ${ticker}`)
    }
  } catch (error) {
    if (connection) {
      await connection.release()
    }
    throw error
  }
}

async function fetchFromExternalAPIs(ticker: string, startDate: string) {

  const errors: string[] = []

  const sources: string[] = [];

  const currentDate = new Date().toISOString().slice(0, 10);



  // Helper to normalize Yahoo Finance data

  const normalizeYahooData = (data: any[]) => {

    return data.map(item => ({

      date: item.date.toISOString().split('T')[0],

      datetime: item.date.toISOString(),

      open: item.open,

      high: item.high,

      low: item.low,

      close: item.close,

      volume: item.volume,

      adjOpen: item.adjClose, // Yahoo provides adjusted close, not open

      adjHigh: item.adjClose,

      adjLow: item.adjClose,

      adjClose: item.adjClose,

      adjVolume: item.volume

    }));

  };



  // Try Yahoo Finance

  try {

    const data = await yahooFinance.historical(ticker, { period1: startDate, period2: currentDate });

    if (data && Array.isArray(data)) {

      sources.push('Yahoo');

      return { historicalData: normalizeYahooData(data), source: sources };

    }

  } catch (error) {

    errors.push(`Yahoo Finance API: ${error instanceof Error ? error.message : 'Network error'}`)

  }



  // All failed - throw error

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

      const { historicalData, source: dataSource } = await fetchFromDatabase(ticker, startDate)

      return Response.json({ historicalData, source: dataSource })

    } else {

      // Use external APIs for direct search requests

      const { historicalData, source: dataSource } = await fetchFromExternalAPIs(ticker, startDate)

      return Response.json({ historicalData, source: dataSource })

    }

  } catch (error) {

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    return Response.json(

      {

        error: source === 'dashboard' ? 'Failed to fetch historical data from database' : 'Failed to fetch historical data from external APIs',

        details: errorMessage,

        ticker: ticker,

        period: period,

        failedServices: source === 'dashboard' ? [] : ['Yahoo']

      },

      { status: 500 }

    )

  }

}
