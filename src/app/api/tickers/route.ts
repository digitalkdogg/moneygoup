import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Fetch from SEC's official company tickers JSON with proper User-Agent
    const response = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: {
        'User-Agent': 'MoneyGroup/1.0 (stock-analysis-app)',
      },
    });

    if (!response.ok) {
      throw new Error(`SEC API returned status ${response.status}`);
    }

    const data = await response.json();

    // Transform the SEC data format to match our Ticker interface
    // SEC format: { "0": { "cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc." }, ... }
    const tickers = Object.values(data).map((item: any) => ({
      ticker: item.ticker,
      name: item.title,
    }));

    // Cache for 24 hours
    return NextResponse.json(tickers, {
      headers: {
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error) {
    console.error('Failed to fetch tickers from SEC:', error);
    
    // Fallback to local file if SEC API fails
    try {
      const response = await fetch('https://localhost:3000/company_tickers.json', {
        cache: 'no-store',
      });
      if (response.ok) {
        const data = await response.json();
        return NextResponse.json(data);
      }
    } catch (fallbackError) {
      console.error('Fallback to local tickers also failed:', fallbackError);
    }

    return NextResponse.json(
      { error: 'Failed to fetch ticker data' },
      { status: 500 }
    );
  }
}
