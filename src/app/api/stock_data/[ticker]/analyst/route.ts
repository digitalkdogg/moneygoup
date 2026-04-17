import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { multiTickerSchema } from '@/utils/validationSchemas';
import { validationErrorResponse } from '@/utils/errorResponse';
import { stockDataLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';
import { analystDataCache } from '@/utils/cache';

const logger = createLogger('api/stock/[ticker]/analyst');

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) return originCheckResponse;

    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const rateLimitResponse = checkRateLimit(request, stockDataLimiter, 'analyst-data');
  if (rateLimitResponse) return rateLimitResponse;

  let validatedTicker: string;
  try {
    validatedTicker = multiTickerSchema.parse(params.ticker);
  } catch (error) {
    return validationErrorResponse('Invalid ticker');
  }

  const tickerArray = validatedTicker.split(',').map(t => t.trim());
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  try {
    const analystDataByTicker: Record<string, any> = {};
    const tickersToFetch: string[] = [];
    let allFromCache = true;

    for (const ticker of tickerArray) {
      if (!forceRefresh) {
        const cached = analystDataCache.get(ticker);
        if (cached) {
          analystDataByTicker[ticker] = cached;
          continue;
        }
      }
      allFromCache = false;
      tickersToFetch.push(ticker);
    }

    if (tickersToFetch.length > 0) {
      const fetchPromises = tickersToFetch.map(async (ticker) => {
        try {
          const summary = await fetchYahooStockSummary(ticker);
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
          analystDataByTicker[ticker] = analyst;
          analystDataCache.set(ticker, analyst);
        } catch (error) {
          const fallback = {
            recommendationTrend: [], recommendationKey: null, numberOfAnalystOpinions: null,
            priceTarget: { low: null, mean: null, median: null, high: null, current: null }
          };
          analystDataByTicker[ticker] = fallback;
        }
      });
      await Promise.all(fetchPromises);
    }

    const source = allFromCache ? 'cache' : 'livedata';

    if (tickerArray.length === 1) {
      return NextResponse.json({ ...analystDataByTicker[tickerArray[0]], source });
    } else {
      return NextResponse.json({ analystData: analystDataByTicker, source: ['Yahoo Finance'], cache_status: source });
    }
  } catch (error) {
    logger.error('Error in analyst API:', { error });
    return NextResponse.json({ error: 'Failed to fetch analyst data' }, { status: 500 });
  }
}
