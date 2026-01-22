// src/app/api/get/fmp/[ticker]/route.ts
import { NextResponse } from 'next/server';

async function fetchFmpData(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to fetch from ${url}: ${response.status} ${response.statusText} - ${errorBody}`);
  }
  return response.json();
}

export async function GET(request: Request, { params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase();
  const apiKey = process.env.FMP_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: 'FMP API key is not configured.' },
      { status: 500 }
    );
  }

  const priceUrl = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&apikey=${apiKey}`;
  const marketCapUrl = `https://financialmodelingprep.com/api/v3/historical-market-capitalization/${ticker}?apikey=${apiKey}`;

  try {
    const [priceResult, marketCapResult] = await Promise.allSettled([
      fetchFmpData(priceUrl),
      fetchFmpData(marketCapUrl),
    ]);

    let priceResponse, marketCapResponse;
    const errors = [];

    if (priceResult.status === 'fulfilled') {
      priceResponse = priceResult.value;
    } else {
      errors.push(`Price data fetch failed: ${priceResult.reason.message}`);
    }

    if (marketCapResult.status === 'fulfilled') {
      marketCapResponse = marketCapResult.value;
    } else {
      errors.push(`Market cap data fetch failed: ${marketCapResult.reason.message}`);
    }

    if (errors.length > 0) {
        console.error(`Failed to fetch all data for ticker ${ticker} from FMP:`, errors);
        return NextResponse.json({ error: 'Failed to fetch all data from FMP API', details: errors.join('; ') }, { status: 500 });
    }

    const historicalData = Array.isArray(priceResponse) ? priceResponse : priceResponse.historical;

    if (!historicalData || !Array.isArray(historicalData)) {
      return NextResponse.json({ error: 'Unexpected format for historical price data from FMP.' }, { status: 500 });
    }

    if (!marketCapResponse || !Array.isArray(marketCapResponse)) {
        return NextResponse.json({ error: 'Unexpected format for market cap data from FMP.' }, { status: 500 });
    }

    const marketCapMap = new Map(marketCapResponse.map(item => [item.date, item.marketCap]));

    const mergedData = historicalData.map(record => {
      const date = record.date.split('T')[0];
      if (marketCapMap.has(date)) {
        return { ...record, market_cap: marketCapMap.get(date) };
      }
      return record;
    });

    return NextResponse.json({ historicalData: mergedData, source: 'FMP' });

  } catch (error) {
    // This will catch errors from Promise.allSettled itself or other unexpected errors
    console.error(`An unexpected error occurred for ticker ${ticker}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'An unexpected error occurred', details: errorMessage }, { status: 500 });
  }
}
