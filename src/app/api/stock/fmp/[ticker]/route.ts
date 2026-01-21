import { NextRequest, NextResponse } from 'next/server';

let secCompanyDataCache: { [key: string]: { cik_str: number; ticker: string; title: string } } | null = null;

async function fetchCompanyNameFromSec(ticker: string): Promise<string | null> {
  if (!secCompanyDataCache) {
    try {
      const res = await fetch('https://www.sec.gov/files/company_tickers.json');
      if (!res.ok) {
        console.error('Failed to fetch company_tickers.json from SEC:', res.status, res.statusText);
        return null;
      }
      const data = await res.json();
      secCompanyDataCache = data;
    } catch (error) {
      console.error('Error fetching or parsing company_tickers.json from SEC:', error);
      return null;
    }
  }

  if (secCompanyDataCache) {
    for (const key in secCompanyDataCache) {
      if (secCompanyDataCache.hasOwnProperty(key)) {
        const company = secCompanyDataCache[key];
        if (company.ticker === ticker) {
          return company.title;
        }
      }
    }
  }
  return null;
}

const normalizeFmpData = (data: any, currentSources: string[], secCompanyName: string | null) => {
  if (!data) return {};
  const newSources = [...currentSources, 'FMP'];
  return {
    symbol: data.symbol,
    name: data.name || secCompanyName,
    last: data.price,
    close: data.price,
    open: data.open,
    high: data.dayHigh,
    low: data.dayLow,
    volume: data.volume,
    marketCap: data.marketCap,
    prevClose: data.previousClose,
    timestamp: new Date(data.timestamp * 1000).toISOString(),
    exchange: data.exchange,
    source: newSources
  };
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const resolvedParams = await params;
  const ticker = resolvedParams.ticker.toUpperCase();
  const errors: string[] = [];
  const sources: string[] = [];
  let secCompanyName: string | null = null;

  try {
    secCompanyName = await fetchCompanyNameFromSec(ticker);
    if (secCompanyName) {
      sources.push('SEC');
    }
  } catch (secError) {
    console.warn(`Could not fetch company name from SEC for ${ticker}:`, secError);
  }

  try {
    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey) {
      errors.push('FMP API: API key not configured.');
      return NextResponse.json(
        {
          error: 'Failed to fetch stock data',
          details: errors.join('; '),
          ticker: ticker,
          failedServices: ['FMP']
        },
        { status: 500 }
      );
    }

    const fmpUrl = `https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${apiKey}`;
    const res = await fetch(fmpUrl);

    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0 && !data[0]['Error Message']) {
          const fmpData = data[0];
          if (!fmpData["Error Message"] || !fmpData["Error Message"].includes("not available under your current subscription")) {
               return NextResponse.json(normalizeFmpData(fmpData, sources, secCompanyName));
          }
      }
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`;
      if (res.status === 403) {
          errors.push(`FMP API: Forbidden. Your API key is likely invalid.`)
      } else if (res.status === 402) {
          errors.push(`FMP API: Payment Required. Your FMP account does not have access to this data. Please check your subscription plan.`)
      } else {
          errors.push(`FMP API: ${statusText}`)
      }
    }
  } catch (error) {
    errors.push(`FMP API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  return NextResponse.json(
    {
      error: 'Failed to fetch stock data from FMP API',
      details: errors.join('; '),
      ticker: ticker,
      failedServices: ['FMP']
    },
    { status: 500 }
  );
}