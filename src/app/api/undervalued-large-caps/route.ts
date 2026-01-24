import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

export async function GET(request: NextRequest) {
  try {
    const undervalued = await yahooFinance.screener("undervalued_large_caps");

    const undervaluedLargeCapsStocks = undervalued.quotes
      .filter(q => q.symbol && q.longName && q.regularMarketPrice !== undefined && q.marketCap !== undefined)
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
  } catch (error) {
    console.error('Error fetching undervalued large caps:', error);
    return NextResponse.json(
      { error: 'Failed to fetch undervalued large caps', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
