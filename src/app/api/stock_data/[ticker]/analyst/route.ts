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
    if (originCheckResponse) {
      return originCheckResponse;
    }

    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
  }

  // Check rate limit (per-IP)
  const rateLimitResponse = checkRateLimit(request, stockDataLimiter, 'analyst-data');
  if (rateLimitResponse) return rateLimitResponse;

  // Validate and normalize ticker input
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

  const tickerArray = validatedTicker.split(',').map(t => t.trim());

  try {
    const analystDataByTicker: Record<string, any> = {};

    const fetchPromises = tickerArray.map(async (ticker) => {
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
      } catch (error) {
        logger.warn(`Error fetching analyst data for ${ticker}:`, error);
        analystDataByTicker[ticker] = {
          recommendationTrend: [],
          recommendationKey: null,
          numberOfAnalystOpinions: null,
          priceTarget: { low: null, mean: null, median: null, high: null, current: null }
        };
      }
    });

    await Promise.all(fetchPromises);

    // Return single object if one ticker, array if multiple
    if (tickerArray.length === 1) {
      return NextResponse.json(analystDataByTicker[tickerArray[0]]);
    } else {
      return NextResponse.json({ analystData: analystDataByTicker, source: ['Yahoo Finance'] });
    }
  } catch (error) {
    logger.error('Error in analyst API:', { error });
    return NextResponse.json(
      { error: 'Failed to fetch analyst data' },
      { status: 500 }
    );
  }
}
