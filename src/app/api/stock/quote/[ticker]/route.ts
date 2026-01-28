import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/stock/quote/[ticker]');

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  // 1. Whitelist Check (Origin Header)
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || process.env.NEXTAUTH_URL;
  let allowedOrigins: Set<string>;

  if (allowedOriginsString) {
    // Always use comma-separated string parsing
    allowedOrigins = new Set(allowedOriginsString.split(',').map(o => o.trim()));
  } else {
    allowedOrigins = new Set();
  }

  const requestOrigin = request.headers.get('origin');

  if (allowedOrigins.size > 0 && requestOrigin) {
    if (!allowedOrigins.has(requestOrigin)) {
      // If origin is present but not in the whitelist, then it's unauthorized.
      return new NextResponse(JSON.stringify({ message: 'Unauthorized origin' }), { status: 401 });
    }
  }

  const { ticker } = params;

  if (!ticker) {
    return createErrorResponse(
      new Error('Stock ticker is required'),
      400
    );
  }

  try {
    logger.info(`Fetching real-time quote for ticker: ${ticker}`);

    const yahooFinanceModule = await import('yahoo-finance2');
    // Assuming yahooFinanceModule.default is the YahooFinance constructor
    const YahooFinance = yahooFinanceModule.default;
    const yahooFinanceInstance = new YahooFinance();

    const result = await yahooFinanceInstance.quote(ticker);

    if (!result || !result.regularMarketPrice) {
      logger.warn(`No real-time price found for ticker: ${ticker}`);
      return createErrorResponse(
        new Error(`No real-time price found for ${ticker}`),
        404
      );
    }

    return NextResponse.json(
      {
        symbol: ticker,
        price: result.regularMarketPrice,
        // You can add more fields from result if needed
      },
      { status: 200 }
    );
  } catch (error: any) {
    logger.error(`Error fetching real-time quote for ${ticker}:`, error);
    return createErrorResponse(
      error,
      500
    );
  }
}
