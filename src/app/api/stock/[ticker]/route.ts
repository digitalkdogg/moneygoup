import { NextRequest } from 'next/server'
import { executeRawQuery, transaction } from '@/utils/databaseHelper'
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

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
  try {
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

    const [rows] = await executeRawQuery(query, [ticker, ticker])

    if (Array.isArray(rows) && rows.length > 0) {
      const row = (rows as any[])[0]
      
      // Get previous close (previous trading day)
      try {
        const prevCloseQuery = `
          SELECT close FROM stocksdailyprice
          WHERE stock_id = ? AND date < ?
          ORDER BY date DESC
          LIMIT 1
        `
        const [prevRows] = await executeRawQuery(prevCloseQuery, [row.id, row.date || new Date().toISOString().slice(0, 10)])
        
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
          exchange: 'DATABASE',
          source: ['DATABASE']
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
          exchange: 'DATABASE',
          source: ['DATABASE']
        }
      }
    } else {
      throw new Error(`No data found in database for ticker ${ticker}`)
    }
  } catch (error) {
    throw error
  }
}

async function fetchFromExternalAPIs(ticker: string) {
  const errors: string[] = []
  let secCompanyName: string | null = null;
  const sources: string[] = [];

  try {
    secCompanyName = await fetchCompanyNameFromSec(ticker);
    if (secCompanyName) {
      sources.push('SEC');
    }
  } catch (secError) {
    console.warn(`Could not fetch company name from SEC for ${ticker}:`, secError);
  }

  // Helper to normalize Yahoo Finance data
  const normalizeYahooData = (data: any, currentSources: string[]) => {
    if (!data) return {};
    const newSources = [...currentSources, 'Yahoo'];
    return {
      symbol: data.symbol,
      name: data.longName || secCompanyName,
      last: data.regularMarketPrice,
      close: data.regularMarketPrice,
      open: data.regularMarketOpen,
      high: data.regularMarketDayHigh,
      low: data.regularMarketDayLow,
      volume: data.regularMarketVolume,
      prevClose: data.regularMarketPreviousClose,
      timestamp: new Date(data.regularMarketTime * 1000).toISOString(),
      exchange: data.fullExchangeName,
      peRatio: data.trailingPE, // Assuming Yahoo Finance returns this
      pbRatio: data.priceToBook, // Assuming Yahoo Finance returns this
      marketCap: data.marketCap, // Assuming Yahoo Finance returns this
      source: newSources
    };
  };

  // Try Yahoo Finance
  try {
    const data = await yahooFinance.quote(ticker);
    if (data) {
      return normalizeYahooData(data, sources);
    }
  } catch (error) {
    errors.push(`Yahoo Finance API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // All failed - throw error
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
    console.error(error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return Response.json(
      {
        error: source === 'dashboard' ? 'Failed to fetch stock data from database' : 'Failed to fetch stock data from external APIs',
        ticker: ticker,
        failedServices: source === 'dashboard' ? [] : ['Yahoo']
      },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { ticker: string } }) {
  const stockId = params.ticker; // The `ticker` param is actually `stock_id` in this context

  // Validate stock_id is a positive integer
  const parsedId = parseInt(stockId, 10);
  if (!stockId || isNaN(parsedId) || parsedId <= 0 || !Number.isInteger(parsedId)) {
    return Response.json({ error: 'Invalid stock ID' }, { status: 400 });
  }

  try {
    await transaction(async (connection) => {
      // 1. Delete from stocksdailyprice table
      await connection.execute('DELETE FROM stocksdailyprice WHERE stock_id = ?', [parsedId]);

      // 2. Delete from stocks table
      await connection.execute('DELETE FROM stocks WHERE id = ?', [parsedId]);
    });

    return Response.json({ message: `Stock with ID ${parsedId} and its daily prices removed successfully.` });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error removing stock with ID ${parsedId}:`, errorMessage);
    // Don't expose database-specific error details to client
    return Response.json({ error: 'Failed to remove stock' }, { status: 500 });
  }
}