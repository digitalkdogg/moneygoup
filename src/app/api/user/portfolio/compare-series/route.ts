import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { checkOrigin } from '@/utils/originCheck';
import { tickerSchema } from '@/utils/validationSchemas';

const logger = createLogger('api/user/portfolio/compare-series');

type Period = '1m' | '6m' | '1y' | 'all';

function getStartDate(period: Period, purchaseDate: Date | null): Date {
    const now = new Date();
    const start = new Date();
    switch (period) {
        case '1m': start.setMonth(now.getMonth() - 1); break;
        case '6m': start.setMonth(now.getMonth() - 6); break;
        case '1y': start.setFullYear(now.getFullYear() - 1); break;
        case 'all':
            return purchaseDate ?? new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
    }
    if (purchaseDate && start < purchaseDate) return purchaseDate;
    return start;
}

// GET /api/user/portfolio/compare-series?ticker=AAPL&period=1m
// Returns {date, value}[] where value = shares × close price.
// Same shape as /historical-value so both series sit on the same chart Y-axis.
export async function GET(req: NextRequest) {
    const originCheckResponse = checkOrigin(req);
    if (originCheckResponse) return originCheckResponse;

    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const approvalOutcome = await checkApprovalGuard(session.user.id);
    if (!approvalOutcome.allowed) {
        return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }

    const rawTicker = (req.nextUrl.searchParams.get('ticker') ?? '').toUpperCase();
    let ticker: string;
    try {
        ticker = tickerSchema.parse(rawTicker);
    } catch {
        return NextResponse.json({ error: 'Invalid ticker' }, { status: 400 });
    }

    const periodParam = (req.nextUrl.searchParams.get('period') as Period) || '1m';

    try {
        // 1. Try portfolio_position_history for a pre-computed position series
        const [holdingRow] = await executeRawQuery(
            `SELECT us.shares, us.initial_purchase_date, us.last_transaction_date
             FROM user_stocks us
             JOIN stocks s ON us.stock_id = s.id
             WHERE us.user_id = ? AND s.symbol = ?
               AND us.is_purchased = 1 AND us.is_active = 1 AND us.shares > 0
             LIMIT 1`,
            [session.user.id, ticker]
        ) as any[];

        if (!holdingRow || holdingRow.length === 0) {
            return NextResponse.json({ error: 'Holding not found' }, { status: 404 });
        }

        const { shares, initial_purchase_date, last_transaction_date } = holdingRow[0];
        const rawDate = initial_purchase_date ?? last_transaction_date;
        const purchaseDate = rawDate ? new Date(rawDate) : null;

        const startDate = getStartDate(periodParam, purchaseDate);
        const startDateStr = startDate.toISOString().split('T')[0];

        const [historyRows] = await executeRawQuery(
            `SELECT pph.snapshot_date AS date, pph.market_value AS value
             FROM portfolio_position_history pph
             JOIN stocks s ON pph.stock_id = s.id
             WHERE pph.user_id = ? AND s.symbol = ? AND pph.snapshot_date >= ?
             ORDER BY pph.snapshot_date ASC`,
            [session.user.id, ticker, startDateStr]
        ) as any[];

        if (Array.isArray(historyRows) && historyRows.length > 1) {
            logger.info(`compare-series for ${ticker} from position_history`, { points: historyRows.length, period: periodParam });
            return NextResponse.json(
                historyRows.map((r: any) => ({
                    date: r.date instanceof Date
                        ? r.date.toISOString().split('T')[0]
                        : String(r.date),
                    value: parseFloat(r.value),
                }))
            );
        }

        logger.info(`No position history found for ${ticker} — falling back to live Yahoo Finance data`);

        // 2. Fall back to live Yahoo Finance calculation
        const quotes: any[] = await (yahooFinance as any)
            .chart(ticker, { period1: startDate, period2: new Date(), interval: '1d' })
            .then((r: any) => r.quotes as any[])
            .catch(() => []);

        const data = quotes
            .filter((q: any) => q.close != null)
            .map((q: any) => ({
                date: new Date(q.date).toISOString().split('T')[0],
                value: parseFloat(shares) * (q.adjclose ?? q.close),
            }));

        logger.info(`compare-series for ${ticker}`, { points: data.length, period: periodParam });
        return NextResponse.json(data);
    } catch (error) {
        return createErrorResponse(error, 'Failed to fetch compare series');
    }
}
