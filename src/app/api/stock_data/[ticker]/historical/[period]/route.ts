import { NextRequest, NextResponse } from 'next/server'
import { executeRawQuery } from '@/utils/databaseHelper'
import YahooFinance from 'yahoo-finance2';
import { createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { checkOrigin } from '@/utils/originCheck';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import
import { tickerSchema, periodSchema } from '@/utils/validationSchemas';
import { historicalLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';

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

async function fetchFromDatabase(tickers: string | string[], startDate: string) {
  try {
    // Normalize input to array
    const tickerArray = Array.isArray(tickers) ? tickers : tickers.split(',').map(t => t.trim().toUpperCase());

    const results: Record<string, any> = {};
    const errors: string[] = [];

    // Fetch historical data for each ticker
    const fetchPromises = tickerArray.map(async (ticker) => {
      try {
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

        const [rows] = await executeRawQuery(query, [ticker, startDate])

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
          
          results[ticker] = historicalData;
        } else {
          errors.push(`No historical data found in database for ticker ${ticker}`);
        }
      } catch (error) {
        errors.push(`${ticker}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });

    await Promise.all(fetchPromises);

    // Return results - if any data was found, return it
    if (Object.keys(results).length > 0) {
      return {
        historicalData: results,
        source: ['DATABASE'],
        errors: errors.length > 0 ? errors : undefined
      };
    } else {
      // If no results found for any ticker, throw error with all error messages
      throw new Error(errors.join('; ') || 'No historical data found in database');
    }
  } catch (error) {
    throw error;
  }
}

async function fetchFromExternalAPIs(tickers: string | string[], startDate: string) {
  // Normalize input to array
  const tickerArray = Array.isArray(tickers) ? tickers : tickers.split(',').map(t => t.trim().toUpperCase());

  const results: Record<string, any> = {};
  const errors: string[] = [];
  const sources: string[] = ['Yahoo'];

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

  // Fetch historical data for all tickers in parallel
  const fetchPromises = tickerArray.map(async (ticker) => {
    try {
      const data = await yahooFinance.historical(ticker, { period1: startDate, period2: currentDate });

      if (data && Array.isArray(data) && data.length > 0) {
        results[ticker] = normalizeYahooData(data);
      } else {
        errors.push(`${ticker}: No historical data returned from Yahoo Finance`);
      }
    } catch (error) {
      errors.push(`${ticker}: ${error instanceof Error ? error.message : 'Network error'}`);
    }
  });

  await Promise.all(fetchPromises);

  // Return results - if any data was found, return it
  if (Object.keys(results).length > 0) {
    return {
      historicalData: results,
      source: sources,
      errors: errors.length > 0 ? errors : undefined
    };
  } else {
    // If no results found for any ticker, throw error with all error messages
    throw new Error(errors.join('; ') || 'Failed to fetch historical data from external APIs');
  }
}

// NOTE: This endpoint requires authentication.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string; period: string }> }
) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  // Check rate limit (per-IP)
  const rateLimitResponse = checkRateLimit(request, historicalLimiter, 'historical');
  if (rateLimitResponse) return rateLimitResponse;

  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
  }

  const resolvedParams = await params;

  // Validate ticker and period using schemas
  try {
    var validatedTicker = tickerSchema.parse(resolvedParams.ticker);
    var validatedPeriod = periodSchema.parse(resolvedParams.period);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues && error.issues.length > 0 
        ? error.issues[0].message 
        : 'Invalid parameters';
      return validationErrorResponse(message);
    }
    return validationErrorResponse('Invalid parameters');
  }

  const source = request.nextUrl.searchParams.get('source')

  const getDays = (period: string): number => {
    switch (period) {
      case '1d':
        return 1;
      case '5d':
        return 5;
      case '1mo':
        return 30;
      case '3mo':
        return 90;
      case '6mo':
        return 180;
      case '1y':
        return 365;
      case '5y':
        return 1825;
      case 'max':
        return 10950; // ~30 years
      default:
        return 365;
    }
  }

  const days = getDays(validatedPeriod)

  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  try {
    if (source === 'dashboard') {
      // Use database for dashboard requests
      const { historicalData, source: dataSource, errors } = await fetchFromDatabase(validatedTicker, startDate)
      
      const response: any = { historicalData, source: dataSource };
      if (errors) {
        response.warnings = errors;
      }
      
      return Response.json(response)
    } else {
      // Use external APIs for direct search requests
      const { historicalData, source: dataSource, errors } = await fetchFromExternalAPIs(validatedTicker, startDate)
      
      const response: any = { historicalData, source: dataSource };
      if (errors) {
        response.warnings = errors;
      }
      
      return Response.json(response)
    }
  } catch (error: any) {
    const isDashboardSource = source === 'dashboard';
    const message = isDashboardSource ? 'Failed to fetch historical data from database' : 'Failed to fetch historical data from external APIs';
    const status = isDashboardSource && (error instanceof Error && error.message.includes('No historical data found')) ? 404 : 500;

    return createErrorResponse(error, message, { status });
  }
}
