import { NextResponse } from 'next/server';
import { remove } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../auth/[...nextauth]/route'; // Adjust path for nested folder

const logger = createLogger('api/user/stocks/[stock_id]');

export async function DELETE(
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
    
    const affectedRows = await remove('user_stocks', { user_id: userId, stock_id: parsedId });

    if (affectedRows === 0) {
      return createErrorResponse('Stock not found or not owned by user', 404);
    }

    return NextResponse.json({ message: 'Stock sold successfully' }, { status: 200 });

  } catch (error: any) {
    logger.error("Failed to sell stock:", error);
    return createErrorResponse('Failed to sell stock', 500);
  }
}
