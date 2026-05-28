import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/user/portfolio/transactions');

// GET /api/user/portfolio/transactions?limit=50&offset=0&stock_id=123
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

  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10), 200);
  const offset = Math.max(parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10), 0);
  const stockIdParam = req.nextUrl.searchParams.get('stock_id');
  const stockId = stockIdParam ? parseInt(stockIdParam, 10) : null;

  try {
    const params: any[] = [userId];
    let stockFilter = '';
    if (stockId && !isNaN(stockId)) {
      stockFilter = 'AND pt.stock_id = ?';
      params.push(stockId);
    }
    params.push(limit, offset);

    const [rows] = await executeRawQuery(
      `SELECT
         pt.id,
         pt.stock_id,
         s.symbol,
         s.company_name,
         pt.transaction_type AS type,
         pt.shares,
         pt.price_per_share AS pricePerShare,
         pt.total_amount AS totalAmount,
         pt.fees,
         pt.transaction_date AS transactionDate,
         pt.notes
       FROM portfolio_transactions pt
       JOIN stocks s ON pt.stock_id = s.id
       WHERE pt.user_id = ? ${stockFilter}
       ORDER BY pt.transaction_date DESC
       LIMIT ? OFFSET ?`,
      params
    ) as any[];

    const transactions = (Array.isArray(rows) ? rows : []).map((r: any) => ({
      id: r.id,
      stockId: r.stock_id,
      symbol: r.symbol,
      companyName: r.company_name,
      type: r.type,
      shares: r.shares != null ? parseFloat(r.shares) : null,
      pricePerShare: r.pricePerShare != null ? parseFloat(r.pricePerShare) : null,
      totalAmount: parseFloat(r.totalAmount),
      fees: parseFloat(r.fees),
      transactionDate: r.transactionDate instanceof Date
        ? r.transactionDate.toISOString()
        : r.transactionDate,
      notes: r.notes,
    }));

    logger.info(`Fetched ${transactions.length} transactions for user ${userId}`);
    return NextResponse.json({ transactions, asOf: new Date().toISOString() });
  } catch (error) {
    return createErrorResponse(error, 'Failed to fetch portfolio transactions');
  }
}
