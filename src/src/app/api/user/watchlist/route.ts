import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { validate } from '@/utils/validation';
import { addStockSchema, AddStockInput } from '@/app/api/user/watchlist/schema';
import { executeRawQuery, insert, upsert } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/user/watchlist');

// GET: Fetch user's watchlist
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  const session = await getServerSession(authOptions);

  if (!session || !session.user || !session.user.id) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  const userId = session.user.id;

  try {
    const [watchlistItems] = await executeRawQuery(`
      SELECT
        s.id AS stock_id,
        s.symbol,
        s.company_name,
        us.shares,
        us.purchase_price,
        us.is_purchased
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.id
      WHERE us.user_id = ? AND us.is_purchased = 0
    `, [userId]);

    return NextResponse.json({ watchlist: watchlistItems }, { status: 200 });
  } catch (error: any) {
    logger.error('Error fetching user watchlist:', error);
    return createErrorResponse(error, 500);
  }
}

// POST: Add stock to watchlist
export const POST = validate(addStockSchema)(
  async (request: NextRequest, data: AddStockInput) => {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) {
      return originCheckResponse;
    }
    const session = await getServerSession(authOptions);

    if (!session || !session.user || !session.user.id) {
      return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
    }

    const userId = session.user.id;
    const { ticker, name } = data;

    try {
      // 1. Find existing stock or insert new one
      const [existingStocks] = await executeRawQuery('SELECT id FROM stocks WHERE symbol = ?', [ticker.toUpperCase()]);
      let stockId;

      if (Array.isArray(existingStocks) && existingStocks.length > 0) {
        stockId = existingStocks[0].id;
      } else {
        stockId = await insert('stocks', {
          symbol: ticker.toUpperCase(),
          company_name: name,
        });
      }

      // 2. Add to user_stocks as a watchlist item (is_purchased = 0)
      await upsert('user_stocks', {
        user_id: userId,
        stock_id: stockId,
        is_purchased: 0, // Mark as watchlist item
        shares: 0, // No shares for watchlist
        purchase_price: 0, // No purchase price for watchlist
      }, ['user_id', 'stock_id']); // Use upsert behavior for user_stocks

      return NextResponse.json(
        {
          status: 'success',
          message: 'Stock added to watchlist',
          stock_id: stockId,
        },
        { status: 201 }
      );
    } catch (dbError: any) {
      logger.error('Database error adding stock to watchlist:', dbError);
      return createErrorResponse(dbError, 500);
    }
  }
);

// DELETE: Remove stock from watchlist
export async function DELETE(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  const session = await getServerSession(authOptions);

  if (!session || !session.user || !session.user.id) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  const userId = session.user.id;
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get('stockId'); // Assuming stockId is passed as ticker symbol

  if (!ticker) {
    return new NextResponse(JSON.stringify({ message: 'Stock ticker is required' }), { status: 400 });
  }

  try {
    // 1. Find stock_id from ticker
    const [existingStocks] = await executeRawQuery('SELECT id FROM stocks WHERE symbol = ?', [ticker.toUpperCase()]);
    let stockId;

    if (Array.isArray(existingStocks) && existingStocks.length > 0) {
      stockId = existingStocks[0].id;
    } else {
      // If stock not found in main stocks table, it can't be on watchlist either
      return new NextResponse(JSON.stringify({ message: 'Stock not found' }), { status: 404 });
    }

    // 2. Delete from user_stocks where is_purchased = 0
    await executeRawQuery(
      'DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ? AND is_purchased = 0',
      [userId, stockId]
    );

    return NextResponse.json(
      {
        status: 'success',
        message: 'Stock removed from watchlist',
      },
      { status: 200 }
    );
  } catch (dbError: any) {
    logger.error('Database error removing stock from watchlist:', dbError);
    return createErrorResponse(dbError, 500);
  }
}
