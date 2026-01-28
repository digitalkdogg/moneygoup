import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/stock/quote/[ticker]');

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  // 1. Whitelist Check (Origin Header) - Same logic as /api/dashboard
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || process.env.NEXTAUTH_URL;
  let allowedOrigins: Set<string>;

  if (allowedOriginsString) {
    try {
      const parsed = JSON.parse(allowedOriginsString);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        allowedOrigins = new Set(parsed.map(o => o.trim()));
      } else {
        allowedOrigins = new Set(allowedOriginsString.split(',').map(o => o.trim()));
      }
    } catch (e) {
      allowedOrigins = new Set(allowedOriginsString.split(',').map(o => o.trim()));
    }
  } else {
    allowedOrigins = new Set();
  }

  const requestOrigin = request.headers.get('origin');
  const secFetchSite = request.headers.get('sec-fetch-site');

  if (allowedOrigins.size > 0) {
    if (!requestOrigin) {
      if (secFetchSite === 'same-origin') {
        logger.warn('Missing Origin header but allowed due to same-origin request (Sec-Fetch-Site).');
      } else {
        logger.warn('Missing Origin header for whitelisted stock quote API access attempt (not same-origin).');
        return new NextResponse(JSON.stringify({ message: 'Unauthorized: Missing Origin header' }), { status: 401 });
      }
    } else if (!allowedOrigins.has(requestOrigin)) {
      logger.warn(`Unauthorized origin: ${requestOrigin} attempted to access stock quote API.`);
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
