import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/dashboard/recommended-stocks');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

interface RecommendedStock {
  symbol: string;
  name: string | undefined;
  regularMarketPrice: number;
  marketCap: number | undefined;
  metric?: string | number;
  metricLabel?: string;
}

interface RecommendedStocksResponse {
  momentumPlays: RecommendedStock[];
  breakoutCandidates: RecommendedStock[];
  analystFavorites: RecommendedStock[];
  insiderActivity: RecommendedStock[];
}

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  try {
    logger.info('Fetching recommended stocks');

    // Step 1: Get most active stocks as our universe
    const mostActiveData = await yahooFinance
      .screener('most_actives')
      .catch(() => ({ quotes: [] }));

    const stocks = mostActiveData.quotes
      .filter(q => q.symbol && q.longName && q.regularMarketPrice !== undefined)
      .slice(0, 50); // Top 50 most active

    if (stocks.length === 0) {
      return NextResponse.json({
        momentumPlays: [],
        breakoutCandidates: [],
        analystFavorites: [],
        insiderActivity: [],
      });
    }

    // Step 2: For each stock, fetch historical data and quote data
    const stockAnalysis = await Promise.all(
      stocks.map(async (stock) => {
        try {
          const endDate = new Date();
          const startDate = new Date(endDate);
          startDate.setFullYear(startDate.getFullYear() - 1);

          const [chartData, quoteData] = await Promise.all([
            yahooFinance
              .chart(stock.symbol || '', {
                interval: '1d',
                period1: startDate,
                period2: endDate,
              })
              .catch(() => ({ quotes: [] })),
            yahooFinance
              .quote(stock.symbol || '')
              .catch(() => ({})),
          ]);

          return {
            symbol: stock.symbol,
            name: stock.longName,
            currentPrice: stock.regularMarketPrice,
            marketCap: stock.marketCap,
            chart: chartData.quotes,
            quote: quoteData,
          };
        } catch (error) {
          console.error(`Failed to fetch data for ${stock.symbol}:`, error instanceof Error ? error.message : String(error));
          return null;
        }
      })
    );

    // Step 3: Analyze each stock and categorize
    const momentumPlays: RecommendedStock[] = [];
    const breakoutCandidates: RecommendedStock[] = [];
    const analystFavorites: RecommendedStock[] = [];
    const insiderActivity: RecommendedStock[] = [];

    stockAnalysis.forEach((analysis) => {
      if (!analysis || !analysis.chart || analysis.chart.length === 0) {
        return;
      }

      const {
        symbol,
        name,
        currentPrice,
        marketCap,
        chart,
        quote,
      } = analysis;

      // Calculate 6-month momentum
      const sixMonthAgo = new Date();
      sixMonthAgo.setMonth(sixMonthAgo.getMonth() - 6);
      const chartDataSixMonths = chart.filter((h: any) => {
        const hDate = typeof h.date === 'string' ? new Date(h.date) : h.date;
        return hDate >= sixMonthAgo;
      });

      if (chartDataSixMonths.length > 0) {
        const oldPrice = chartDataSixMonths[0].close;
        if (oldPrice && currentPrice) {
          const momentum = ((currentPrice - oldPrice) / oldPrice) * 100;

          if (momentum > 10) {
            // 10%+ gain in 6 months
            momentumPlays.push({
              symbol,
              name,
              regularMarketPrice: currentPrice,
              marketCap,
              metric: momentum.toFixed(2),
              metricLabel: '6M Change %',
            });
          }
        }
      }

      // Find 52-week high and check breakouts
      if (chart && chart.length > 0) {
        const highPrice = Math.max(...chart.map((h: any) => h.high || h.close));
        const distanceFromHigh = (
          ((currentPrice - highPrice) / highPrice) *
          100
        ).toFixed(2);

        // Breakout if within 5% of 52-week high
        if (Math.abs(Number(distanceFromHigh)) <= 5) {
          breakoutCandidates.push({
            symbol,
            name,
            regularMarketPrice: currentPrice,
            marketCap,
            metric: distanceFromHigh,
            metricLabel: '% from 52W High',
          });
        }
      }

      // Check for analyst ratings - show stocks with strong buy or buy ratings
      if (quote && 'averageAnalystRating' in quote && quote.averageAnalystRating) {
        const ratingStr = String(quote.averageAnalystRating);
        // Parse string like "1.4 - Strong Buy" or "2 - Buy"
        const ratingMatch = ratingStr.match(/^([\d.]+)/);
        if (ratingMatch) {
          const rating = parseFloat(ratingMatch[1]);
          // Yahoo uses 1-5 scale: 1=Strong Buy, 2=Buy, 3=Hold, 4=Sell, 5=Strong Sell
          if (rating <= 2) {
            // Strong Buy or Buy
            analystFavorites.push({
              symbol,
              name,
              regularMarketPrice: currentPrice,
              marketCap,
              metric: ratingStr,
              metricLabel: 'Analyst Rating',
            });
          }
        }
      }

      // Check insider holdings - look for any holding-related field
      // For now, we'll flag stocks where the company data suggests insider interest
      if (quote && 'heldPercent' in quote && quote.heldPercent !== undefined && quote.heldPercent > 0.1) {
        const heldPct = ((quote.heldPercent as number) * 100).toFixed(2);
        insiderActivity.push({
          symbol,
          name,
          regularMarketPrice: currentPrice,
          marketCap,
          metric: heldPct,
          metricLabel: 'Insider Hold %',
        });
      }
    });

    // Sort each category
    momentumPlays.sort((a, b) => Number(b.metric) - Number(a.metric));
    breakoutCandidates.sort(
      (a, b) => Math.abs(Number(b.metric)) - Math.abs(Number(a.metric))
    );
    analystFavorites.sort((a, b) => Number(b.metric) - Number(a.metric));
    insiderActivity.sort((a, b) => Number(b.metric) - Number(a.metric));

    const response: RecommendedStocksResponse = {
      momentumPlays: momentumPlays.slice(0, 8),
      breakoutCandidates: breakoutCandidates.slice(0, 8),
      analystFavorites: analystFavorites.slice(0, 8),
      insiderActivity: insiderActivity.slice(0, 8),
    };

    return NextResponse.json(response);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Error fetching recommended stocks:', err);

    return NextResponse.json(
      {
        error: 'Failed to fetch recommended stocks',
        details: err.message,
      },
      { status: 500 }
    );
  }
}
