import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import YahooFinance from 'yahoo-finance2';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/stock/[ticker]/earnings');

// Declare yahooFinance outside to potentially reuse, but initialize inside GET for testing
let yahooFinanceInstance: InstanceType<typeof YahooFinance> | null = null;

export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  const { ticker } = params;

  if (!ticker) {
    return new NextResponse(JSON.stringify({ message: 'Ticker is required' }), { status: 400 });
  }

  // Initialize yahooFinance if it hasn't been already
  if (!yahooFinanceInstance) {
    logger.info("Initializing yahooFinance instance within GET function.");
    yahooFinanceInstance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  try {
    const quoteSummary = await yahooFinanceInstance.quoteSummary(ticker, { modules: ['earnings'] });

    const earningsData = quoteSummary.earnings;
    logger.info("Raw earnings data for debugging:", earningsData);

    if (!earningsData || (!earningsData.financialsChart && !earningsData.earningsChart)) {
      return NextResponse.json({
        upcomingEarnings: null,
        historicalEarnings: [],
        message: 'No earnings data available for this ticker.',
      }, { status: 200 });
    }

        const upcomingEarnings = (earningsData.earningsChart?.earningsDate?.[0] as any)?.fmt || null;

    

        const historicalDataMap: Map<string, any> = new Map();

    

        // Process earningsChart.quarterly for EPS data

        if (earningsData.earningsChart?.quarterly) {

          earningsData.earningsChart.quarterly.forEach((q: any) => {

            historicalDataMap.set(q.date, {

              date: q.date,

              epsActual: q.actual,

              epsEstimate: q.estimate,

              revenue: null, // Initialize

              earnings: null, // Initialize

            });

          });

        }

    

        // Process financialsChart.quarterly for Revenue and Earnings data

        if (earningsData.financialsChart?.quarterly) {

          earningsData.financialsChart.quarterly.forEach((q: any) => {

            const existingData = historicalDataMap.get(q.date);

            if (existingData) {

              historicalDataMap.set(q.date, {

                ...existingData,

                revenue: q.revenue,

                earnings: q.earnings,

              });

            } else {

              // If financial data exists but no corresponding EPS data (less common)

              historicalDataMap.set(q.date, {

                date: q.date,

                epsActual: null,

                epsEstimate: null,

                revenue: q.revenue,

                earnings: q.earnings,

              });

            }

          });

        }

    

        // Convert map to array and sort by date (newest first for 1Q2025, 2Q2025 etc.)

        const combinedHistoricalEarnings = Array.from(historicalDataMap.values()).sort((a, b) => {

            // Custom sort for "XQYYYY" format

            const parseQuarterDate = (dateStr: string) => {

                const match = dateStr.match(/(\d)Q(\d{4})/);

                if (match) {

                    const quarter = parseInt(match[1]);

                    const year = parseInt(match[2]);

                    return year * 10 + quarter; // Convert to a comparable number

                }

                return 0; // Fallback for unparsable dates, puts them at the beginning

            };

            return parseQuarterDate(b.date) - parseQuarterDate(a.date);

        });

    

    

        return NextResponse.json({

          upcomingEarnings,

          historicalEarnings: combinedHistoricalEarnings,

        }, { status: 200 });

  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Error fetching earnings data for ${ticker}:`, err);
    return createErrorResponse(err, 500);
  }
}
