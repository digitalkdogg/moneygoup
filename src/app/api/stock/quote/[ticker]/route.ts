import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { checkOrigin } from '@/utils/originCheck';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import
import { tickerSchema } from '@/utils/validationSchemas';
import { quoteLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';

const logger = createLogger('api/stock/quote/[ticker]');

// NOTE: This endpoint requires authentication.
export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  // Check rate limit (per-IP)
  const rateLimitResponse = checkRateLimit(request, quoteLimiter, 'quote');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  // Validate ticker
  try {
    var validatedTicker = tickerSchema.parse(params.ticker);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues && error.issues.length > 0 
        ? error.issues[0].message 
        : 'Invalid ticker';
      return validationErrorResponse(message);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  try {


    const yahooFinanceModule = await import('yahoo-finance2');
    // Assuming yahooFinanceModule.default is the YahooFinance constructor
    const YahooFinance = yahooFinanceModule.default;
    const yahooFinanceInstance = new YahooFinance();

    const result = await yahooFinanceInstance.quote(validatedTicker);

    if (!result || !result.regularMarketPrice) {
      logger.warn(`No real-time price found for ticker: ${validatedTicker}`);
      return createErrorResponse(
        new Error(`No real-time price found for ${validatedTicker}`), `No real-time price found for ${validatedTicker}`,
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        symbol: validatedTicker,
        price: result.regularMarketPrice,
        // You can add more fields from result if needed
      },
      { status: 200 }
    );
  } catch (error: any) {
    logger.error(`Error fetching real-time quote for ${validatedTicker}:`, error);
    return createErrorResponse(
      error, `Error fetching real-time quote for ${validatedTicker}`,
      { status: 500 }
    );
  }
}
