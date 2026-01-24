import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

export async function GET(request: NextRequest) {
  try {
    const growthTech = await yahooFinance.screener("growth_technology_stocks");

    const topTechStocks = growthTech.quotes
      .filter(q => q.symbol && q.longName && q.regularMarketPrice !== undefined && q.marketCap !== undefined)
      .slice(0, 10) // Limit to top 10
      .map(q => ({
        symbol: q.symbol,
        name: q.longName,
        regularMarketPrice: q.regularMarketPrice,
        marketCap: q.marketCap,
        trailingPE: q.trailingPE,
      }));

    return NextResponse.json(topTechStocks);
  } catch (error) {
    console.error('Error fetching growth technology stocks:', error);
    return NextResponse.json(
      { error: 'Failed to fetch top technology stocks', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
