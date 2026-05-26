import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import YahooFinance from 'yahoo-finance2';
import { createErrorResponse, validationErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';
import { earningsCache } from '@/utils/cache';

const logger = createLogger('api/stock/[ticker]/earnings');

const formatEarningsDate = (dateValue: any): string | null => {
  if (!dateValue) return null;
  let date: Date | null = null;
  let dateString: string | null = null;

  if (typeof dateValue === 'string') {
    dateString = dateValue;
  }
  else if (typeof dateValue === 'number') {
    date = new Date(dateValue * 1000);
  }
  else if (typeof dateValue === 'object' && dateValue !== null) {
    if ((dateValue as any).fmt) return (dateValue as any).fmt;
    if ((dateValue as any).date) {
      dateString = (dateValue as any).date;
    } else if ((dateValue as any).earningsDate) {
      dateString = (dateValue as any).earningsDate;
    } else if ((dateValue as any).toString && typeof (dateValue as any).toString === 'function') {
      dateString = (dateValue as any).toString();
    }
  }

  if (dateString && !date) date = new Date(dateString);

  if (date) {
    const timeValue = date.getTime();
    if (!isNaN(timeValue)) {
      return date.toLocaleDateString('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric'
      });
    }
  }
  return null;
};

let yahooFinanceInstance: InstanceType<typeof YahooFinance> | null = null;

export async function GET(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) return originCheckResponse;

    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    const approvalOutcome = await checkApprovalGuard((session as any).user?.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
  }

  const { ticker: rawTicker } = await params;
  let validatedTicker: string;
  try {
    validatedTicker = tickerSchema.parse(rawTicker);
  } catch (error) {
    return validationErrorResponse('Invalid ticker');
  }

  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  if (!forceRefresh) {
    const cachedData = earningsCache.get(validatedTicker);
    if (cachedData) {
      return NextResponse.json({ ...cachedData as any, source: 'cache' });
    }
  }

  if (!yahooFinanceInstance) {
    yahooFinanceInstance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  try {
    const quoteSummary = await yahooFinanceInstance.quoteSummary(validatedTicker, {
      modules: ['earnings', 'calendarEvents']
    });

    const earningsData = quoteSummary.earnings;
    const calendarEvents = quoteSummary.calendarEvents;

    if (!earningsData || (!earningsData.financialsChart && !earningsData.earningsChart)) {
      const resp = { upcomingEarnings: null, historicalEarnings: [], message: 'No earnings data available' };
      earningsCache.set(validatedTicker, resp);
      return NextResponse.json({ ...resp, source: 'livedata' });
    }

    let upcomingEarnings = null;
    if (earningsData.earningsChart?.earningsDate) {
      const earningsDateEntry = earningsData.earningsChart.earningsDate[0];
      if (earningsDateEntry) upcomingEarnings = formatEarningsDate(earningsDateEntry);
    }
    if (!upcomingEarnings && calendarEvents?.earnings?.[0]) {
      const nextEarnings = calendarEvents.earnings[0];
      upcomingEarnings = formatEarningsDate((nextEarnings as any)?.earningsDate || (nextEarnings as any)?.date || nextEarnings);
    }

    const historicalDataMap: Map<string, any> = new Map();
    if (earningsData.earningsChart?.quarterly) {
      earningsData.earningsChart.quarterly.forEach((q: any) => {
        historicalDataMap.set(q.date, { date: q.date, epsActual: q.actual, epsEstimate: q.estimate, revenue: null, earnings: null });
      });
    }
    if (earningsData.financialsChart?.quarterly) {
      earningsData.financialsChart.quarterly.forEach((q: any) => {
        const existingData = historicalDataMap.get(q.date);
        if (existingData) {
          historicalDataMap.set(q.date, { ...existingData, revenue: q.revenue, earnings: q.earnings });
        } else {
          historicalDataMap.set(q.date, { date: q.date, epsActual: null, epsEstimate: null, revenue: q.revenue, earnings: q.earnings });
        }
      });
    }

    const combinedHistoricalEarnings = Array.from(historicalDataMap.values()).sort((a, b) => {
      const parseQuarterDate = (dateStr: string) => {
        const match = dateStr.match(/(\d)Q(\d{4})/);
        return match ? parseInt(match[2]) * 10 + parseInt(match[1]) : 0;
      };
      return parseQuarterDate(b.date) - parseQuarterDate(a.date);
    });

    const responseData = { upcomingEarnings, historicalEarnings: combinedHistoricalEarnings };
    earningsCache.set(validatedTicker, responseData);
    return NextResponse.json({ ...responseData, source: 'livedata' }, { status: 200 });

  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Error fetching earnings data for ${validatedTicker}:`, err);
    return createErrorResponse(err, `Error fetching earnings data for ${validatedTicker}`, { status: 500 });
  }
}
