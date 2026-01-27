import { NextResponse } from 'next/server';
import { remove, update } from '@/utils/databaseHelper'; // Add 'update'
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const logger = createLogger('api/user/stocks/[stock_id]');

export async function PUT(
  request: Request,
  { params }: { params: { stock_id: string } }
) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  try {
    const stockId = params.stock_id;

    // Validate stock_id is a positive integer
    const parsedId = parseInt(stockId, 10);
    if (!stockId || isNaN(parsedId) || parsedId <= 0 || !Number.isInteger(parsedId)) {
      return createErrorResponse('Invalid stock ID', 400);
    }

    const userId = session.user.id;
    
    // Update user_stocks to reflect "sold" state (i.e., move back to watchlist)
    const affectedRows = await update(
      'user_stocks',
      { is_purchased: 0, shares: 0, purchase_price: 0 },
      { user_id: userId, stock_id: parsedId }
    );

    if (affectedRows === 0) {
      // If no rows were affected, it means the stock was not found or not owned by the user.
      return createErrorResponse('Stock not found or not owned by user', 404);
    }

    return NextResponse.json({ message: 'Stock sold successfully (moved to watchlist)' }, { status: 200 });

  } catch (error: any) {
    logger.error("Failed to sell stock:", error);
    return createErrorResponse('Failed to sell stock', 500);
  }
}
