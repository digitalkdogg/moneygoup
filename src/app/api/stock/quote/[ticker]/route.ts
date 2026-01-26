import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/stock/quote/[ticker]');

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const { ticker } = params;

  if (!ticker) {
    return createErrorResponse(
      new Error('Stock ticker is required'),
      400,
      'Invalid Request'
    );
  }

  try {
    logger.info(`Fetching real-time quote for ticker: ${ticker}`);

    const yahooFinanceModule = await import('yahoo-finance2');
    console.log("DEBUG: yahooFinanceModule:", yahooFinanceModule);
    console.log("DEBUG: yahooFinanceModule.default:", yahooFinanceModule.default);

    // Try instantiating yahooFinanceModule.default directly, if it's the class
    let yahooFinanceInstance;
    if (typeof yahooFinanceModule.default === 'function' && yahooFinanceModule.default.name === 'YahooFinance') {
      yahooFinanceInstance = new yahooFinanceModule.default();
    } else if (yahooFinanceModule.default && typeof yahooFinanceModule.default.YahooFinance === 'function') {
    const yahooFinanceInstance = new yahooFinanceModule.default();
    } else if (typeof yahooFinanceModule.YahooFinance === 'function') { // Fallback if it's not a default export but named
      yahooFinanceInstance = new yahooFinanceModule.YahooFinance();
    } else {
      throw new Error("Could not find YahooFinance constructor in imported module.");
    }
    
    console.log("DEBUG: yahooFinanceInstance:", yahooFinanceInstance);

    const result = await yahooFinanceInstance.quote(ticker);

    if (!result || !result.regularMarketPrice) {
      logger.warn(`No real-time price found for ticker: ${ticker}`);
      return createErrorResponse(
        new Error(`No real-time price found for ${ticker}`),
        404,
        'Not Found'
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
      500,
      `Failed to fetch real-time quote for ${ticker}`
    );
  }
}
