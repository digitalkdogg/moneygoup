import { NextRequest, NextResponse } from 'next/server'
import { checkOrigin } from '@/utils/originCheck'
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators'

export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const originCheckResponse = checkOrigin(request)
  if (originCheckResponse) return originCheckResponse

  const tickerString = params.ticker.toUpperCase()
  const tickerArray = tickerString.split(',').map(t => t.trim())

  const origin = request.nextUrl?.origin || ''

  try {
    // Fetch data for all tickers in parallel
    const fetchPromises = tickerArray.map(async (ticker) => {
      try {
        const stockPromise = fetch(`${origin}/api/stock/${ticker}`)
        const newsPromise = fetch(`${origin}/api/stock/${ticker}/news`)
        const histPromise = fetch(`${origin}/api/stock/${ticker}/historical/1y`)

        const [stockRes, newsRes, histRes] = await Promise.all([stockPromise, newsPromise, histPromise])

        const stockData = stockRes.ok ? await stockRes.json() : { error: `Failed to fetch stock: ${stockRes.status}` };
        const stockJson = Array.isArray(stockData) ? stockData[0] : stockData;
        const newsJson = newsRes.ok ? await newsRes.json() : { error: `Failed to fetch news: ${newsRes.status}` };
        const histJson = histRes.ok ? await histRes.json() : { error: `Failed to fetch historical: ${histRes.status}` };

        // Calculate indicators if all data is available
        let indicators = null;
        if (histRes.ok && newsRes.ok && stockRes.ok && stockJson && histJson.historicalData) {
          // Handle both single ticker (array of data points) and multiple ticker (object with tickers as keys) formats
          const historicalData = histJson.historicalData[ticker] || histJson.historicalData;
          const newsArticles = newsJson.articles?.[ticker] || newsJson.articles || [];

          indicators = calculateTechnicalIndicators(
            historicalData,
            newsArticles,
            stockJson.peRatio,
            stockJson.pbRatio,
            stockJson.marketCap
          );
        }

        return {
          ticker,
          stock: stockJson,
          news: newsJson,
          historical: histJson,
          indicators
        };
      } catch (error) {
        return {
          ticker,
          error: `Failed to fetch data for ${ticker}`,
          details: error instanceof Error ? error.message : String(error)
        };
      }
    });

    const results = await Promise.all(fetchPromises);

    // Format response based on number of tickers
    if (tickerArray.length === 1) {
      // Single ticker: return data directly
      const result = results[0];
      return NextResponse.json({
        stock: result.stock,
        news: result.news,
        historical: result.historical,
        indicators: result.indicators,
        ...(result.error && { error: result.error, details: result.details })
      });
    } else {
      // Multiple tickers: return object with tickers as keys
      const consolidatedData: Record<string, any> = {};
      results.forEach(result => {
        consolidatedData[result.ticker] = {
          stock: result.stock,
          news: result.news,
          historical: result.historical,
          indicators: result.indicators,
          ...(result.error && { error: result.error, details: result.details })
        };
      });
      return NextResponse.json(consolidatedData);
    }
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch consolidated stock data', details: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
