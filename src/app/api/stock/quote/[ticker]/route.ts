import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';
import { checkOrigin } from '@/utils/originCheck';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import

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

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const { ticker } = params;

  if (!ticker) {
    return createErrorResponse(
      new Error('Stock ticker is required'), 'Stock ticker is required',
      { status: 400 }
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
        new Error(`No real-time price found for ${ticker}`), `No real-time price found for ${ticker}`,
        { status: 404 }
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
      error, `Error fetching real-time quote for ${ticker}`,
      { status: 500 }
    );
  }
}
