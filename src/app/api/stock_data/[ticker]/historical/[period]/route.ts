import { NextRequest, NextResponse } from 'next/server'
import { executeRawQuery } from '@/utils/databaseHelper'
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { checkOrigin } from '@/utils/originCheck';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { tickerSchema, periodSchema } from '@/utils/validationSchemas';
import { historicalLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';
import { historicalDataCache } from '@/utils/cache';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/stock/[ticker]/historical');

const getDays = (period: string): number => {
  switch (period) {
    case '1d': return 1;
    case '5d': return 5;
    case '1mo': return 30;
    case '3mo': return 90;
    case '6mo': return 180;
    case '1y': return 365;
    case '5y': return 1825;
    case 'max': return 10950;
    default: return 365;
  }
}

async function fetchFromDatabase(tickers: string | string[], startDate: string) {
  try {
    const tickerArray = Array.isArray(tickers) ? tickers : tickers.split(',').map(t => t.trim().toUpperCase());
    const results: Record<string, any> = {};
    const errors: string[] = [];

    const fetchPromises = tickerArray.map(async (ticker) => {
      try {
        const query = `
          SELECT sdp.date, sdp.open, sdp.high, sdp.low, sdp.close, sdp.volume, sdp.adj_open, sdp.adj_high, sdp.adj_low, sdp.adj_close, sdp.adj_volume
          FROM stocks s INNER JOIN stocksdailyprice sdp ON s.id = sdp.stock_id
          WHERE s.symbol = ? AND sdp.date >= ? ORDER BY sdp.date ASC
        `
        const [rows] = await executeRawQuery(query, [ticker, startDate])
        if (Array.isArray(rows) && rows.length > 0) {
          results[ticker] = (rows as any[]).map(row => ({
            date: row.date, datetime: row.date, open: parseFloat(row.open), high: parseFloat(row.high), low: parseFloat(row.low), close: parseFloat(row.close),
            volume: parseInt(row.volume, 10), adjOpen: parseFloat(row.adj_open), adjHigh: parseFloat(row.adj_high), adjLow: parseFloat(row.adj_low),
            adjClose: parseFloat(row.adj_close), adjVolume: parseInt(row.adj_volume, 10)
          }));
        } else {
          errors.push(`No historical data found for ${ticker}`);
        }
      } catch (error) {
        errors.push(`${ticker}: ${error instanceof Error ? error.message : 'Error'}`);
      }
    });
    await Promise.all(fetchPromises);
    if (Object.keys(results).length > 0) return { historicalData: results, source: ['DATABASE'], errors: errors.length > 0 ? errors : undefined };
    throw new Error(errors.join('; '));
  } catch (error) { throw error; }
}

async function fetchFromExternalAPIs(tickers: string | string[], startDate: string) {
  const tickerArray = Array.isArray(tickers) ? tickers : tickers.split(',').map(t => t.trim().toUpperCase());
  const results: Record<string, any> = {};
  const errors: string[] = [];
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const currentDate = yesterday.toISOString().slice(0, 10);

  const fetchPromises = tickerArray.map(async (ticker) => {
    try {
      const chartResult = await yahooFinance.chart(ticker, { period1: startDate, period2: currentDate, interval: '1d' });
      const data = chartResult.quotes;
      if (data && Array.isArray(data) && data.length > 0) {
        results[ticker] = data.filter(item => item.date && item.close != null).map(item => {
          const adjClose = item.adjClose ?? item.adjclose ?? item.close;
          return {
            date: item.date instanceof Date ? item.date.toISOString().split('T')[0] : String(item.date).split('T')[0],
            datetime: item.date instanceof Date ? item.date.toISOString() : String(item.date),
            open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume,
            adjOpen: adjClose, adjHigh: adjClose, adjLow: adjClose, adjClose: adjClose, adjVolume: item.volume
          };
        });
      } else {
        errors.push(`${ticker}: No data from Yahoo`);
      }
    } catch (error) {
      errors.push(`${ticker}: ${error instanceof Error ? error.message : 'Error'}`);
    }
  });
  await Promise.all(fetchPromises);
  if (Object.keys(results).length > 0) return { historicalData: results, source: ['Yahoo'], errors: errors.length > 0 ? errors : undefined };
  throw new Error(errors.join('; '));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string; period: string }> }
) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const rateLimitResponse = await checkRateLimit(request, historicalLimiter, 'historical');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  const approvalOutcome = await checkApprovalGuard((session as any).user?.id);
  if (!approvalOutcome.allowed) {
    return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
  }

  const resolvedParams = await params;
  try {
    var validatedTicker = tickerSchema.parse(resolvedParams.ticker);
    var validatedPeriod = periodSchema.parse(resolvedParams.period);
  } catch (error) { return validationErrorResponse('Invalid parameters'); }

  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source');
  const forceRefresh = searchParams.get('refresh') === 'true';

  const cacheKey = `${validatedTicker}_${validatedPeriod}_${source || 'external'}`;
  if (!forceRefresh) {
    const cached = historicalDataCache.get(cacheKey);
    if (cached) return NextResponse.json({ ...cached as any, cache_status: 'cache' });
  }

  const days = getDays(validatedPeriod);
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try {
    let result: any;
    if (source === 'dashboard') {
      const { historicalData, source: dataSource, errors } = await fetchFromDatabase(validatedTicker, startDate);
      result = { historicalData, source: dataSource, warnings: errors };
    } else {
      const { historicalData, source: dataSource, errors } = await fetchFromExternalAPIs(validatedTicker, startDate);
      result = { historicalData, source: dataSource, warnings: errors };
    }
    historicalDataCache.set(cacheKey, result);
    return NextResponse.json({ ...result, cache_status: 'livedata' });
  } catch (error: any) {
    return createErrorResponse(error, 'Failed to fetch historical data', { status: 500 });
  }
}
