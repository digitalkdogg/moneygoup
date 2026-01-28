import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const yahooFinance = new YahooFinance();
const logger = createLogger('api/dashboard/top-tech');

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  try {
    const growthTech = await yahooFinance.screener("growth_technology_stocks");

    const topTechStocks = growthTech.quotes
      .filter(q => q.symbol && q.longName && q.regularMarketPrice !== undefined && q.marketCap !== undefined && q.priceToBook !== undefined)
      .slice(0, 10) // Limit to top 10
      .map(q => ({
        symbol: q.symbol,
        name: q.longName,
        regularMarketPrice: q.regularMarketPrice,
        marketCap: q.marketCap,
        trailingPE: q.trailingPE,
        priceToBook: q.priceToBook,
      }));

    return NextResponse.json(topTechStocks);
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
