import { NextRequest, NextResponse } from 'next/server'
import { executeRawQuery, transaction } from '@/utils/databaseHelper'
import YahooFinance from 'yahoo-finance2';
import { createErrorResponse } from '@/utils/errorResponse';
import { secCompanyCache } from '@/utils/cache';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import

const yahooFinance = new YahooFinance();

async function fetchCompanyNameFromSec(ticker: string): Promise<string | null> {
  // Check cache first
  const cachedData = secCompanyCache.get('sec_tickers');

  let secCompanyData = cachedData;

  if (!secCompanyData) {
    try {
      const res = await fetch('https://www.sec.gov/files/company_tickers.json');
      if (!res.ok) {
        console.error('Failed to fetch company_tickers.json from SEC:', res.status, res.statusText);
        return null;
      }
      secCompanyData = await res.json();
      if (!secCompanyData) {
        console.error('SEC company_tickers.json is empty or invalid');
        return null;
      }
      // Cache for 24 hours (default for secCompanyCache)
      secCompanyCache.set('sec_tickers', secCompanyData);
    } catch (error) {
      console.error('Error fetching or parsing company_tickers.json from SEC:', error);
      return null;
    }
  }

  if (secCompanyData) {
    // The SEC JSON is an object with keys "0", "1", "2", ...
    // Each value is an object { cik_str, ticker, title }
    for (const key in secCompanyData) {
      if (Object.prototype.hasOwnProperty.call(secCompanyData, key)) {
        const company = secCompanyData[key];
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
    if (!data) { // Explicitly handle cases where Yahoo Finance returns no data but doesn't throw an error
      throw new Error("StockNotFoundError: " + ticker);
    }
    return normalizeYahooData(data, sources);
  } catch (error: any) {
    if (error.message && error.message.startsWith("StockNotFoundError:")) {
      throw error; // Re-throw the custom error for upstream handling
    }
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
  } catch (error: any) {
    console.error(error);
    
    // Check for our custom StockNotFoundError
    if (error.message && error.message.startsWith("StockNotFoundError:")) {
      return createErrorResponse("Stock not available", 404);
    }
    
    const isDashboardSource = source === 'dashboard';
    const message = isDashboardSource ? 'Failed to fetch stock data from database' : 'Failed to fetch stock data from external APIs';
    const status = isDashboardSource && (error instanceof Error && error.message.includes('No data found')) ? 404 : 500;
    
    return createErrorResponse(error, status);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { ticker: string } }) {
  // Add authentication check
  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  // Add authorization check
  // Deleting a global stock is a highly sensitive action impacting all users.
  // For now, we will forbid this action for all regular authenticated users.
  // If an admin role system is implemented, this check would be adjusted to
  // allow only users with 'admin' role.
  return new NextResponse(JSON.stringify({ message: 'Forbidden: This action requires administrative privileges.' }), { status: 403 });


}