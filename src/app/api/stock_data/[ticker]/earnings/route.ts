import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import YahooFinance from 'yahoo-finance2';
import { createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';

const logger = createLogger('api/stock/[ticker]/earnings');

// Helper function to format earnings date
const formatEarningsDate = (dateValue: any): string | null => {
  if (!dateValue) return null;

  let date: Date | null = null;
  let dateString: string | null = null;

  // If it's a string, try to parse it as ISO or date string
  if (typeof dateValue === 'string') {
    dateString = dateValue;
  }
  // If it's a number (Unix timestamp in seconds)
  else if (typeof dateValue === 'number') {
    date = new Date(dateValue * 1000);
  }
  // If it's an object, try to extract a date
  else if (typeof dateValue === 'object' && dateValue !== null) {
    // Try common property names
    if ((dateValue as any).fmt) {
      return (dateValue as any).fmt;
    }
    if ((dateValue as any).date) {
      dateString = (dateValue as any).date;
    } else if ((dateValue as any).earningsDate) {
      dateString = (dateValue as any).earningsDate;
    } else if ((dateValue as any).toString && typeof (dateValue as any).toString === 'function') {
      dateString = (dateValue as any).toString();
    }
  }

  // Parse the date string if we have one
  if (dateString && !date) {
    date = new Date(dateString);
  }

  // Format the date as M/D/YYYY
  if (date) {
    const timeValue = date.getTime();

    if (!isNaN(timeValue)) {
      const formatted = date.toLocaleDateString('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric'
      });
      return formatted;
    }
  }

  return null;
};

// Declare yahooFinance outside to potentially reuse, but initialize inside GET for testing
let yahooFinanceInstance: InstanceType<typeof YahooFinance> | null = null;

// NOTE: This endpoint requires authentication.
export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) {
      return originCheckResponse;
    }

    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
  }

  // Validate ticker
  try {
    var validatedTicker = tickerSchema.parse(params.ticker);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues && error.issues.length > 0 
        ? error.issues[0].message 
        : 'Invalid ticker';
      return validationErrorResponse(message);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  // Initialize yahooFinance if it hasn't been already
  if (!yahooFinanceInstance) {
    yahooFinanceInstance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  try {
    // Fetch earnings data with multiple modules to get calendar info
    const quoteSummary = await yahooFinanceInstance.quoteSummary(validatedTicker, {
      modules: ['earnings', 'calendarEvents']
    });

    const earningsData = quoteSummary.earnings;
    const calendarEvents = quoteSummary.calendarEvents;

    // Log the structure for debugging
    logger.info(`Earnings data structure for ${validatedTicker}:`, {
      hasEarningsChart: !!earningsData?.earningsChart,
      hasEarningsDate: !!earningsData?.earningsChart?.earningsDate,
      earningsDateLength: earningsData?.earningsChart?.earningsDate?.length,
      earningsDateSample: earningsData?.earningsChart?.earningsDate?.[0],
      hasCalendarEvents: !!calendarEvents,
      calendarEarnings: calendarEvents?.earnings?.[0],
    });

    if (!earningsData || (!earningsData.financialsChart && !earningsData.earningsChart)) {
      return NextResponse.json({
        upcomingEarnings: null,
        historicalEarnings: [],
        message: 'No earnings data available for this ticker.',
      }, { status: 200 });
    }

        // Extract upcoming earnings date - try multiple approaches
        let upcomingEarnings = null;

        // First try earningsChart.earningsDate
        if (earningsData.earningsChart?.earningsDate) {
          const earningsDateEntry = earningsData.earningsChart.earningsDate[0];
          logger.info(`[DEBUG] earningsDateEntry raw:`, { earningsDateEntry });
          if (earningsDateEntry) {
            upcomingEarnings = formatEarningsDate(earningsDateEntry);
            logger.info(`[DEBUG] formatEarningsDate result:`, { upcomingEarnings });
          }
        }

        // If that didn't work, try calendar events
        if (!upcomingEarnings && calendarEvents?.earnings?.[0]) {
          const nextEarnings = calendarEvents.earnings[0];
          upcomingEarnings = formatEarningsDate(
            (nextEarnings as any)?.earningsDate ||
            (nextEarnings as any)?.date ||
            nextEarnings
          );
          logger.info(`[DEBUG] from calendar events:`, { upcomingEarnings });
        }

        logger.info(`[DEBUG] Final upcomingEarnings:`, { upcomingEarnings });

    

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
    logger.error(`Error fetching earnings data for ${validatedTicker}:`, err);
    return createErrorResponse(err, `Error fetching earnings data for ${validatedTicker}`, { status: 500 });
  }
}
