import { NextRequest } from 'next/server'
import { getDbConnection } from '@/utils/db'

let secCompanyDataCache: { [key: string]: { cik_str: number; ticker: string; title: string } } | null = null;

async function fetchCompanyNameFromSec(ticker: string): Promise<string | null> {
  if (!secCompanyDataCache) {
    try {
      const res = await fetch('https://www.sec.gov/files/company_tickers.json');
      if (!res.ok) {
        console.error('Failed to fetch company_tickers.json from SEC:', res.status, res.statusText);
        return null;
      }
      const data = await res.json();
      secCompanyDataCache = data;
    } catch (error) {
      console.error('Error fetching or parsing company_tickers.json from SEC:', error);
      return null;
    }
  }

  if (secCompanyDataCache) {
    // The SEC JSON is an object with keys "0", "1", "2", ...
    // Each value is an object { cik_str, ticker, title }
    for (const key in secCompanyDataCache) {
      if (secCompanyDataCache.hasOwnProperty(key)) {
        const company = secCompanyDataCache[key];
        if (company.ticker === ticker) {
          return company.title;
        }
      }
    }
  }
  return null;
}

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
  let secCompanyName: string | null = null;

  try {
    secCompanyName = await fetchCompanyNameFromSec(ticker);
  } catch (secError) {
    console.warn(`Could not fetch company name from SEC for ${ticker}:`, secError);
  }

  // Helper to normalize Tiingo data
  const normalizeTiingoData = (data: any) => {
    if (!data) return {};
    return {
      symbol: data.ticker,
      name: secCompanyName, // Use SEC name, as Tiingo IEX doesn't provide it
      last: data.last,
      close: data.last, // Use last for close
      open: data.open,
      high: data.high,
      low: data.low,
      volume: data.volume,
      prevClose: data.prevClose,
      timestamp: data.timestamp,
      exchange: 'IEX'
    };
  };

  // Helper to normalize 12Data
  const normalizeTwelveData = (data: any) => {
    if (!data || !data.symbol) return {};
    return {
      symbol: data.symbol,
      name: data.name || secCompanyName, // Use 12Data name, fallback to SEC name
      last: parseFloat(data.close),
      close: parseFloat(data.close),
      open: parseFloat(data.open),
      high: parseFloat(data.high),
      low: parseFloat(data.low),
      volume: parseInt(data.volume, 10),
      prevClose: parseFloat(data.previous_close),
      timestamp: data.datetime, // or data.timestamp
      exchange: data.exchange
    };
  };

  // Try Tiingo first
  try {
    const res = await fetch(`https://api.tiingo.com/iex/${ticker}?token=${process.env.TIINGO_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      if (data && data.length > 0) {
        return normalizeTiingoData(data[0]);
      }
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
      if (data && data.symbol) {
        return normalizeTwelveData(data);
      }
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

export async function DELETE(request: NextRequest, { params }: { params: { ticker: string } }) {
  const stockId = params.ticker; // The `ticker` param is actually `stock_id` in this context

  if (!stockId || isNaN(Number(stockId))) {
    return Response.json({ error: 'Invalid stock ID' }, { status: 400 });
  }

  let connection;
  try {
    connection = await getDbConnection();

    // Start a transaction
    await connection.beginTransaction();

    // 1. Delete from stocksdailyprice table
    await connection.execute('DELETE FROM stocksdailyprice WHERE stock_id = ?', [stockId]);

    // 2. Delete from stocks table
    await connection.execute('DELETE FROM stocks WHERE id = ?', [stockId]);

    // Commit the transaction
    await connection.commit();

    await connection.end();
    return Response.json({ message: `Stock with ID ${stockId} and its daily prices removed successfully.` });

  } catch (error) {
    if (connection) {
      await connection.rollback(); // Rollback on error
      await connection.end();
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error removing stock with ID ${stockId}:`, errorMessage);
    return Response.json({ error: 'Failed to remove stock', details: errorMessage }, { status: 500 });
  }
}