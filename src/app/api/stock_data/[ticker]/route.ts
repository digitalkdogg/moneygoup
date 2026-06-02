import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/utils/internalAuth';
import { executeRawQuery, transaction } from '@/utils/databaseHelper'
import { createErrorResponse, unauthorizedResponse, forbiddenResponse, validationErrorResponse } from '@/utils/errorResponse';
import { secCompanyCache, stockDataCache } from '@/utils/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators';
import { createLogger } from '@/utils/logger';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
import { tickerSchema, multiTickerSchema } from '@/utils/validationSchemas';
import { stockDataLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';
import { LimitService } from '@/utils/limitService';
import { checkApprovalGuard } from '@/utils/approvalStatus';

const logger = createLogger('api/stock/[ticker]');

// Map to track in-flight requests for deduplication
const inflightRequests = new Map<string, Promise<any>>();

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
    timestamp: data.regularMarketTime ? new Date(data.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
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
    const results = await Promise.all(tickerArray.map(async (ticker) => {
      try {
        const summary = await fetchYahooStockSummary(ticker);

        const data = {
            ...summary.assetProfile,
            ...summary.price,
            ...summary.summaryDetail,
            ...summary.quoteType,
            ...summary.financialData,
            ...summary.defaultKeyStatistics,
        };

        if (!data || !data.symbol) {
          throw new Error(`StockNotFoundError: ${ticker}`);
        }
        const normalized = normalizeYahooData(data, sources, secCompanyNames);
        if (normalized) {
          return {
            stock: normalized,
            analyst: {
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
            }
          };
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

    if (validResults.length === 0) {
      throw new Error(errors.join('; ') || 'Failed to fetch stock data from external APIs');
    }

    return tickerArray.length === 1 ? [validResults[0]] : validResults;
  } catch (error: any) {
    throw error;
  }
}


export async function GET(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const originCheckResponse = checkOrigin(request)
  if (originCheckResponse) return originCheckResponse

  // Check rate limit (per-IP)
  const rateLimitResponse = await checkRateLimit(request, stockDataLimiter, 'stock-data');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const userRole = (session.user as any).role || 'user';

  const isInternal = isInternalRequest(request);

  // 0. Check role-based limits BEFORE cache (skip if internal)
  if (!isInternal) {
    const approvalOutcome = await checkApprovalGuard(userId);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
    const limitCheck = await LimitService.canPerformLookup(userId, userRole);
    if (!limitCheck.allowed) {
      logger.warn('Lookup limit exceeded', { userId, userRole, current: limitCheck.current });
      return NextResponse.json(
        {
          code: 'LIMIT_EXCEEDED',
          dimension: 'lookups',
          allowed: limitCheck.max,
          current: limitCheck.current,
          message: `Lookup limit exceeded. Your current limit is ${limitCheck.max} lookups per 24h.`
        },
        { status: 403 }
      );
    }
  }

  // Validate ticker parameter
  const { ticker: rawTicker } = await params;
  try {
    var validatedTicker = multiTickerSchema.parse(rawTicker);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues && error.issues.length > 0 
        ? error.issues[0].message 
        : 'Invalid ticker';
      return validationErrorResponse(message);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  // Check cache unless refresh is requested
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  if (!forceRefresh) {
    const cachedData = stockDataCache.get(validatedTicker);
    if (cachedData) {
      return NextResponse.json({ ...cachedData as any, source: 'cache' });
    }
  }

  // If there's already an in-flight request for this ticker, wait for it instead of duplicating
  if (inflightRequests.has(validatedTicker)) {
    try {
      const data = await inflightRequests.get(validatedTicker)!;
      return NextResponse.json({ ...data, source: 'livedata' });
    } catch (error) {
      return createErrorResponse(error, 'Failed to fetch consolidated stock data');
    }
  }

  const tickerArray = validatedTicker.split(',').map(t => t.trim())
  const origin = request.nextUrl?.origin || ''

  // Create the promise FIRST and add to map immediately to prevent race condition
  let resolvePromise: (value: any) => void;
  let rejectPromise: (reason?: any) => void;
  const dataPromise = new Promise<any>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  // Mark as in-flight BEFORE doing any async work
  inflightRequests.set(validatedTicker, dataPromise);

  // Now execute the actual fetch logic
  (async () => {
  // Record lookup event immediately on cache miss, before expensive fetches
  if (!isInternal) {
    await LimitService.recordLookupEvent(userId, validatedTicker, 'stock_data_api');
  }

  try {
    // Fetch related data in batch for tickers requested
    const histAllTickersPromise = fetch(`${origin}/api/stock_data/${validatedTicker}/historical/1y`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });
    const newsAllTickersPromise = fetch(`${origin}/api/stock_data/${validatedTicker}/news`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });
    const analystAllTickersPromise = fetch(`${origin}/api/stock_data/${validatedTicker}/analyst`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });

    const [histAllTickersRes, newsAllTickersRes, analystAllTickersRes] = await Promise.all([
      histAllTickersPromise,
      newsAllTickersPromise,
      analystAllTickersPromise
    ]);

    const histAllTickersJson = histAllTickersRes.ok ? await histAllTickersRes.json() : { historicalData: {}, error: `Failed to fetch historical` };
    const newsAllTickersJson = newsAllTickersRes.ok ? await newsAllTickersRes.json() : { articles: {}, error: `Failed to fetch news` };
    const analystAllTickersJson = analystAllTickersRes.ok ? await analystAllTickersRes.json() : { analystData: {}, error: `Failed to fetch analyst` };

    const fetchPromises = tickerArray.map(async (ticker) => {
      try {
        const externalDataArray = await fetchFromExternalAPIs(ticker)
        const earningsPromise = fetch(`${origin}/api/stock_data/${ticker}/earnings`, { headers: { 'Cookie': request.headers.get('Cookie') || '' } });

        const externalData = (externalDataArray && externalDataArray.length > 0) ? externalDataArray[0] : { error: 'Failed to fetch stock' };
        const stockJson = (externalData as any).stock;
        const analystJson = (externalData as any).analyst;

        const newsJson = {
          articles: newsAllTickersJson.articles?.[ticker] || [],
          source: newsAllTickersJson.source,
          error: newsAllTickersJson.error
        };

        const histJson = {
          historicalData: histAllTickersJson.historicalData?.[ticker] || [],
          source: histAllTickersJson.source,
          error: histAllTickersJson.error
        };

        const earningsRes = await earningsPromise;
        const earningsJson = earningsRes.ok ? await earningsRes.json() : null;

        let indicators = null;
        if (
          newsJson.articles &&
          newsJson.articles.length > 0 &&
          histJson.historicalData &&
          histJson.historicalData.length > 0 &&
          stockJson &&
          'symbol' in stockJson
        ) {
          const historicalData = histJson.historicalData;
          const newsArticles = newsJson.articles;

          const peRatio = stockJson.peRatio ?? null;
          const pbRatio = stockJson.pbRatio ?? null;
          const marketCap = stockJson.marketCap ?? null;

          indicators = calculateTechnicalIndicators(
            historicalData,
            newsArticles,
            peRatio,
            pbRatio,
            marketCap
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
        };
      }
    });

    const results = await Promise.all(fetchPromises);

    let finalResponse;
    if (tickerArray.length === 1) {
      const result = results[0];
      finalResponse = {
        stock: result.stock,
        news: result.news,
        historical: result.historical,
        indicators: result.indicators,
        earnings: result.earnings,
        analyst: result.analyst,
        ...(result.error && { error: result.error })
      };
    } else {
      const consolidatedData: Record<string, any> = {};
      results.forEach(result => {
        consolidatedData[result.ticker] = {
          stock: result.stock,
          news: result.news,
          historical: result.historical,
          indicators: result.indicators,
          earnings: result.earnings,
          analyst: result.analyst,
          ...(result.error && { error: result.error })
        };
      });
      finalResponse = consolidatedData;
    }

    // Cache final result
    stockDataCache.set(validatedTicker, finalResponse);

    resolvePromise!(finalResponse);
  } catch (error) {
    rejectPromise!(error);
  } finally {
    inflightRequests.delete(validatedTicker);
  }
  })();

  // Return the promise that will be resolved with the response
  try {
    const data = await dataPromise;
    return NextResponse.json({ ...data, source: 'livedata' });
  } catch (error) {
    return createErrorResponse(error, 'Failed to fetch consolidated stock data');
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return unauthorizedResponse();
  }

  const approvalOutcome = await checkApprovalGuard(session.user.id);
  if (!approvalOutcome.allowed) {
    return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
  }

  return forbiddenResponse('Forbidden: This action requires administrative privileges.');
}
