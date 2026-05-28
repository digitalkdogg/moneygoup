import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/user/portfolio/benchmark');

type Period = '1m' | '6m' | '1y' | 'all';

function getStartDate(period: Period): string {
  const d = new Date();
  switch (period) {
    case '1m': d.setMonth(d.getMonth() - 1); break;
    case '6m': d.setMonth(d.getMonth() - 6); break;
    case '1y': d.setFullYear(d.getFullYear() - 1); break;
    case 'all': d.setFullYear(d.getFullYear() - 10); break;
  }
  return d.toISOString().split('T')[0];
}

// GET /api/user/portfolio/benchmark?period=1m|6m|1y|all
export async function GET(req: NextRequest) {
  const originCheckResponse = checkOrigin(req);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const approvalOutcome = await checkApprovalGuard(userId);
  if (!approvalOutcome.allowed) {
    return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
  }

  const period = (req.nextUrl.searchParams.get('period') as Period) || '1m';
  const startDate = getStartDate(period);

  try {
    const [rows] = await executeRawQuery(
      `SELECT
         snapshot_date AS date,
         portfolio_return_pct AS portfolioReturnPct,
         spy_return_pct AS spyReturnPct,
         alpha_pct AS alphaPct
       FROM portfolio_benchmark_performance
       WHERE user_id = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`,
      [userId, startDate]
    ) as any[];

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ data: [], asOf: new Date().toISOString() });
    }

    const data = rows.map((r: any) => ({
      date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
      portfolioReturnPct: r.portfolioReturnPct != null ? parseFloat(r.portfolioReturnPct) : null,
      spyReturnPct: r.spyReturnPct != null ? parseFloat(r.spyReturnPct) : null,
      alphaPct: r.alphaPct != null ? parseFloat(r.alphaPct) : null,
    }));

    const latest = data[data.length - 1];
    logger.info(`benchmark for user ${userId}`, { points: data.length, period, latestAlpha: latest?.alphaPct });

    return NextResponse.json({ data, asOf: new Date().toISOString() });
  } catch (error) {
    return createErrorResponse(error, 'Failed to fetch benchmark performance');
  }
}
