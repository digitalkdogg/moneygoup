import { NextRequest, NextResponse } from 'next/server'
import { executeRawQuery, transaction } from '@/utils/databaseHelper'
import YahooFinance from 'yahoo-finance2';
import { createErrorResponse } from '@/utils/errorResponse';
import { secCompanyCache } from '@/utils/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators'; // Added this import

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

// Helper to normalize Yahoo Finance data
const normalizeYahooData = (data: any, currentSources: string[]) => {
  if (!data) return null;
  const newSources = [...currentSources, 'Yahoo'];
  return {
    symbol: data.symbol,
    name: data.longName || secCompanyNames[data.symbol],
    last: data.regularMarketPrice,
    close: data.regularMarketPrice,
    open: data.regularMarketOpen,
    high: data.regularMarketDayHigh,
    low: data.regularMarketDayLow,
    volume: data.regularMarketVolume,
    prevClose: data.regularMarketPreviousClose,
    timestamp: new Date(data.regularMarketTime * 1000).toISOString(),
    exchange: data.fullExchangeName,
    peRatio: data.trailingPE,
    pbRatio: data.priceToBook,
    marketCap: data.marketCap,
    source: newSources
  };
};


async function fetchFromExternalAPIs(tickers: string | string[]) {
  // Normalize input to array
  const tickerArray = Array.isArray(tickers) ? tickers : tickers.split(',').map(t => t.trim().toUpperCase());
  
  const errors: string[] = [];
  const results: any[] = [];
  const secCompanyNames: Record<string, string | null> = {};
  const sources: string[] = [];

  // Fetch SEC company names for all tickers
  try {
    const secPromises = tickerArray.map(async (ticker) => {
      try {
        secCompanyNames[ticker] = await fetchCompanyNameFromSec(ticker);
        if (secCompanyNames[ticker]) {
          if (!sources.includes('SEC')) sources.push('SEC');
        }
      } catch (secError) {
        console.warn(`Could not fetch company name from SEC for ${ticker}:`, secError);
        secCompanyNames[ticker] = null;
      }
    });
    await Promise.all(secPromises);
  } catch (error) {
    console.error('Error fetching SEC company names:', error);
  }

  // Try Yahoo Finance for all tickers
  try {
    // Fetch all tickers in one call using quote with multiple symbols
    const yahooPromises = tickerArray.map(async (ticker) => {
      try {
        const data = await yahooFinance.quote(ticker);
        if (!data) {
          throw new Error(`StockNotFoundError: ${ticker}`);
        }
        const normalized = normalizeYahooData(data, sources);
        if (normalized) {
          results.push(normalized);
        }
      } catch (error: any) {
        if (error.message && error.message.startsWith('StockNotFoundError:')) {
          errors.push(`${ticker}: Stock not found`);
        } else {
          errors.push(`${ticker}: ${error instanceof Error ? error.message : 'Network error'}`);
        }
      }
    });

    await Promise.all(yahooPromises);

    // If no results were successfully fetched, throw an error
    if (results.length === 0) {
      throw new Error(errors.join('; ') || 'Failed to fetch stock data from external APIs');
    }

    // Return single object if one ticker, array if multiple
    return tickerArray.length === 1 ? [results[0]] : results;
  } catch (error: any) {
    throw error;
  }
}


// The new GET handler, modified from get/route.ts
export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const originCheckResponse = checkOrigin(request)
  if (originCheckResponse) return originCheckResponse

  const tickerString = params.ticker.toUpperCase()
  const tickerArray = tickerString.split(',').map(t => t.trim())

  const origin = request.nextUrl?.origin || ''

  try {
    // 1. Fetch historical data for all tickers in a single call
    const histAllTickersPromise = fetch(`${origin}/api/stock/${tickerString}/historical/1y`);
    const histAllTickersRes = await histAllTickersPromise;
    const histAllTickersJson = histAllTickersRes.ok ? await histAllTickersRes.json() : { historicalData: {}, error: `Failed to fetch historical for all tickers: ${histAllTickersRes.status}` };

    // 2. Fetch news data for all tickers in a single call
    const newsAllTickersPromise = fetch(`${origin}/api/stock/${tickerString}/news`);
    const newsAllTickersRes = await newsAllTickersPromise;
    const newsAllTickersJson = newsAllTickersRes.ok ? await newsAllTickersRes.json() : { articles: {}, error: `Failed to fetch news for all tickers: ${newsAllTickersRes.status}` };

    // Fetch data for all tickers in parallel
    const fetchPromises = tickerArray.map(async (ticker) => {
      try {
        const stockDataArray = await fetchFromExternalAPIs(ticker)
        // Removed individual newsPromise and histPromise, now handled by combined fetches above

        // stockDataArray is already an array from fetchFromExternalAPIs, get the first element for single ticker
        const stockData = (stockDataArray && stockDataArray.length > 0) ? stockDataArray[0] : { error: 'Failed to fetch stock' };
        const stockJson = stockData;

        // Extract news data for the current ticker from the pre-fetched all-tickers response
        const newsJson = {
          articles: newsAllTickersJson.articles?.[ticker] || [],
          source: newsAllTickersJson.source,
          error: newsAllTickersJson.error
        };

        // Extract historical data for the current ticker from the pre-fetched all-tickers response
        const histJson = {
          historicalData: histAllTickersJson.historicalData?.[ticker] || [],
          source: histAllTickersJson.source,
          error: histAllTickersJson.error
        };


        // Calculate indicators if all data is available
        let indicators = null;
        // Check if historical data and news data was successfully fetched for this specific ticker
        if (newsJson.articles && newsJson.articles.length > 0 && histJson.historicalData && histJson.historicalData.length > 0 && stockJson) {
          const historicalData = histJson.historicalData;
          const newsArticles = newsJson.articles;

          indicators = calculateTechnicalIndicators(
            historicalData,
            newsArticles,
            stockJson.peRatio,
            stockJson.pbRatio,
            stockJson.marketCap
          );
        }

        return {
          ticker,
          stock: stockJson,
          news: newsJson,
          historical: histJson,
          indicators
        };
      } catch (error) {
        return {
          ticker,
          error: `Failed to fetch data for ${ticker}`,
          details: error instanceof Error ? error.message : String(error)
        };
      }
    });

    const results = await Promise.all(fetchPromises);

    // Format response based on number of tickers
    if (tickerArray.length === 1) {
      // Single ticker: return data directly
      const result = results[0];
      return NextResponse.json({
        stock: result.stock,
        news: result.news,
        historical: result.historical,
        indicators: result.indicators,
        ...(result.error && { error: result.error, details: result.details })
      });
    } else {
      // Multiple tickers: return object with tickers as keys
      const consolidatedData: Record<string, any> = {};
      results.forEach(result => {
        consolidatedData[result.ticker] = {
          stock: result.stock,
          news: result.news,
          historical: result.historical,
          indicators: result.indicators,
          ...(result.error && { error: result.error, details: result.details })
        };
      });
      return NextResponse.json(consolidatedData);
    }
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch consolidated stock data', details: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

// The DELETE handler from the original route.ts
export async function DELETE(request: NextRequest, { params }: { params: { ticker: string } }) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
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