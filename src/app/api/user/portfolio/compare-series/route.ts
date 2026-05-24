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
        const [rows] = await executeRawQuery(
            `SELECT us.shares, us.initial_purchase_date
             FROM user_stocks us
             JOIN stocks s ON us.stock_id = s.id
             WHERE us.user_id = ? AND s.symbol = ?
               AND us.is_purchased = 1 AND us.is_active = 1 AND us.shares > 0
             LIMIT 1`,
            [session.user.id, ticker]
        ) as any[];

        if (!rows || rows.length === 0) {
            return NextResponse.json({ error: 'Holding not found' }, { status: 404 });
        }

        const { shares, initial_purchase_date } = rows[0];
        const purchaseDate = initial_purchase_date ? new Date(initial_purchase_date) : null;
        const startDate = getStartDate(periodParam, purchaseDate);

        const quotes: any[] = await (yahooFinance as any)
            .historical(ticker, { period1: startDate, period2: new Date() })
            .catch(() => []);

        const data = quotes
            .filter((q: any) => q.close != null)
            .map((q: any) => ({
                date: new Date(q.date).toISOString().split('T')[0],
                value: parseFloat(shares) * (q.adjClose ?? q.close),
            }));

        logger.info(`compare-series for ${ticker}`, { points: data.length, period: periodParam });
        return NextResponse.json(data);
    } catch (error) {
        return createErrorResponse(error, 'Failed to fetch compare series');
    }
}
