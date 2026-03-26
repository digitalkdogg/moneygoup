import { NextRequest, NextResponse } from 'next/server'
import { executeRawQuery, transaction } from '@/utils/databaseHelper'
import { createErrorResponse, unauthorizedResponse, forbiddenResponse, validationErrorResponse } from '@/utils/errorResponse';
import { secCompanyCache } from '@/utils/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators';
import { createLogger } from '@/utils/logger';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper'; // Import the new helper function
import { tickerSchema, multiTickerSchema } from '@/utils/validationSchemas';
import { stockDataLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';

const logger = createLogger('api/stock/[ticker]');

async function fetchCompanyNameFromSec(ticker: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000); // 5-second timeout

  try {
    // Check cache first
    const cachedData = secCompanyCache.get('sec_tickers');

    let secCompanyData = cachedData;

    if (!secCompanyData) {
      const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
        signal: controller.signal,
      });

      if (!res.ok) {
        logger.warn(`Failed to fetch company_tickers.json from SEC: ${res.status} ${res.statusText}`, { ticker });
        return null;
      }
      secCompanyData = await res.json();
      if (!secCompanyData) {
        logger.warn('SEC company_tickers.json is empty or invalid', { ticker });
        return null;
      }
      // Cache for 24 hours (default for secCompanyCache)
      secCompanyCache.set('sec_tickers', secCompanyData);
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
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn('SEC ticker fetch timed out — proceeding without company name', { ticker });
      return null;
    }
    logger.error('Error fetching or parsing company_tickers.json from SEC:', { error: err, ticker });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
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
const normalizeYahooData = (data: any, currentSources: string[], secCompanyNames: Record<string, string | null> = {}) => {
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
    peRatio: data.trailingPE ?? null, // Use null if undefined
    pbRatio: data.priceToBook ?? null, // Use null if undefined
    marketCap: data.marketCap,
    sector: data.sector,
    industry: data.industry,
    longBusinessSummary: data.longBusinessSummary,
    source: newSources
  };
};


async function fetchFromExternalAPIs(tickers: string | string[]) {
  // Normalize input to array
  const tickerArray = Array.isArray(tickers) ? tickers : tickers.split(',').map(t => t.trim().toUpperCase());
  
  const errors: string[] = [];
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
    const results = await Promise.all(tickerArray.map(async (ticker) => {
      try {
        const summary = await fetchYahooStockSummary(ticker); // Use the helper function

        const data = {
            ...summary.assetProfile,
            ...summary.price,
            ...summary.summaryDetail,
            ...summary.quoteType,
            ...summary.financialData,
            ...summary.defaultKeyStatistics,
        };

        const analyst = {
          recommendationTrend: summary.recommendationTrend?.trend || [],
          recommendationKey: summary.financialData?.recommendationKey || null,
          numberOfAnalystOpinions: summary.financialData?.numberOfAnalystOpinions || null,
          priceTarget: {
            low: summary.financialData?.targetLowPrice || null,
            mean: summary.financialData?.targetMeanPrice || null,
            median: summary.financialData?.targetMedianPrice || null,
            high: summary.financialData?.targetHighPrice || null,
            current: summary.financialData?.currentPrice || summary.price?.regularMarketPrice || null
          }
        };

        if (!data || !data.symbol) {
          throw new Error(`StockNotFoundError: ${ticker}`);
        }
        const normalized = normalizeYahooData(data, sources, secCompanyNames);
        if (normalized) {
          return normalized;
        }
        console.warn(`Normalization failed for ${ticker}`);
        return null;
      } catch (error: any) {
        console.error(`Error in fetchFromExternalAPIs for ${ticker}:`, error.message);
        if (error.message && error.message.startsWith('StockNotFoundError:')) {
          errors.push(`${ticker}: Stock not found`);
        } else {
          errors.push(`${ticker}: ${error instanceof Error ? error.message : 'Network error'}`);
        }
        return null;
      }
    }));

    const validResults = results.filter(r => r !== null);

    // If no results were successfully fetched, throw an error
    if (validResults.length === 0) {
      throw new Error(errors.join('; ') || 'Failed to fetch stock data from external APIs');
    }

    // Return single object if one ticker, array if multiple
    return tickerArray.length === 1 ? [validResults[0]] : validResults;
  } catch (error: any) {
    throw error;
  }
}


// The new GET handler, modified from get/route.ts
// NOTE: This endpoint requires authentication.
export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const originCheckResponse = checkOrigin(request)
  if (originCheckResponse) return originCheckResponse

  // Check rate limit (per-IP)
  const rateLimitResponse = checkRateLimit(request, stockDataLimiter, 'stock-data');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  // Validate ticker parameter
  try {
    var validatedTicker = multiTickerSchema.parse(params.ticker);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues && error.issues.length > 0 
        ? error.issues[0].message 
        : 'Invalid ticker';
      return validationErrorResponse(message);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  const tickerArray = validatedTicker.split(',').map(t => t.trim())

  const origin = request.nextUrl?.origin || ''

  try {
    // 1. Fetch historical data for all tickers in a single call
    const histAllTickersPromise = fetch(`${origin}/api/stock_data/${validatedTicker}/historical/1y`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });
    const histAllTickersRes = await histAllTickersPromise;
    const histAllTickersJson = histAllTickersRes.ok ? await histAllTickersRes.json() : { historicalData: {}, error: `Failed to fetch historical for all tickers: ${histAllTickersRes.status}` };

    // 2. Fetch news data for all tickers in a single call
    const newsAllTickersPromise = fetch(`${origin}/api/stock_data/${validatedTicker}/news`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });
    const newsAllTickersRes = await newsAllTickersPromise;
    const newsAllTickersJson = newsAllTickersRes.ok ? await newsAllTickersRes.json() : { articles: {}, error: `Failed to fetch news for all tickers: ${newsAllTickersRes.status}` };

    // 3. Fetch analyst data for all tickers in a single call
    const analystAllTickersPromise = fetch(`${origin}/api/stock_data/${validatedTicker}/analyst`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });
    const analystAllTickersRes = await analystAllTickersPromise;
    const analystAllTickersJson = analystAllTickersRes.ok ? await analystAllTickersRes.json() : { analystData: {}, error: `Failed to fetch analyst for all tickers: ${analystAllTickersRes.status}` };

    // 4. Fetch earnings data for all tickers in a single call (if possible, else we'll loop)
    // There is no batch earnings endpoint currently, so we'll fetch them in the map below.

    // Fetch data for all tickers in parallel
    const fetchPromises = tickerArray.map(async (ticker) => {
      try {
        const stockDataArray = await fetchFromExternalAPIs(ticker)
        
        // Fetch earnings for this ticker
        const earningsPromise = fetch(`${origin}/api/stock_data/${ticker}/earnings`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });

        // stockDataArray is already an array from fetchFromExternalAPIs, get the first element for single ticker
        const stockData = (stockDataArray && stockDataArray.length > 0) ? stockDataArray[0] : { error: 'Failed to fetch stock' };
        const stockJson = stockData;

        // Extract analyst data for the current ticker
        const analystJson = tickerArray.length === 1 
          ? analystAllTickersJson 
          : (analystAllTickersJson.analystData?.[ticker] || null);

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

        const earningsRes = await earningsPromise;
        const earningsJson = earningsRes.ok ? await earningsRes.json() : null;

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
          stock: stockJson || { error: 'Missing stock data' },
          news: newsJson || { articles: [] },
          historical: histJson || { historicalData: [] },
          indicators: indicators || null,
          earnings: earningsJson || null,
          analyst: analystJson
        };
      } catch (error) {
        logger.error(`Error in GET map for ${ticker}:`, { error });
        return {
          ticker,
          stock: { error: 'Failed to fetch' },
          news: { articles: [] },
          historical: { historicalData: [] },
          indicators: null,
          earnings: null,
          analyst: null,
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
        earnings: result.earnings,
        analyst: result.analyst,
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
          earnings: result.earnings,
          analyst: result.analyst,
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
    return unauthorizedResponse();
  }

  // Add authorization check
  // Deleting a global stock is a highly sensitive action impacting all users.
  // For now, we will forbid this action for all regular authenticated users.
  // If an admin role system is implemented, this check would be adjusted to
  // allow only users with 'admin' role.
  return forbiddenResponse('Forbidden: This action requires administrative privileges.');
}