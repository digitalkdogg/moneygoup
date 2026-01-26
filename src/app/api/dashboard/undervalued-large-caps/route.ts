import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';

const logger = createLogger('api/dashboard/undervalued-large-caps');
const yahooFinance = new YahooFinance();
export async function GET(request: NextRequest) {
  try {
    const undervalued = await yahooFinance.screener("undervalued_large_caps");

    const undervaluedLargeCapsStocks = undervalued.quotes
      .filter(q => q.symbol && q.longName && q.regularMarketPrice !== undefined && q.marketCap !== undefined && q.region === 'US')
      .slice(0, 10) // Limit to top 10
      .map(q => ({
        symbol: q.symbol,
        name: q.longName,
        regularMarketPrice: q.regularMarketPrice,
        marketCap: q.marketCap,
        trailingPE: q.trailingPE,
        priceToBook: q.priceToBook,
      }));

    return NextResponse.json(undervaluedLargeCapsStocks);
  } catch (error: unknown) {
  const err =
    error instanceof Error ? error : new Error(String(error));

  logger.error('Error fetching growth technology stocks:', err);

  return NextResponse.json(
    {
      error: 'Failed to fetch top technology stocks',
      details: err.message,
    },
    { status: 500 }
  );
}
}
