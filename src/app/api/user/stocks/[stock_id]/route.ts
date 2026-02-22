import { NextResponse } from 'next/server';
import { remove, update, executeRawQuery } from '@/utils/databaseHelper'; // Add executeRawQuery
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';
import { validate } from '@/utils/validation';
import { checkOrigin } from '@/utils/originCheck'; // Add this import

const logger = createLogger('api/user/stocks/[stock_id]');

// Schema for buy/sell operations
const tradeSchema = z.object({
  action: z.enum(['buy', 'sell_partial', 'sell_all']),
  shares: z.number().positive('Shares must be positive').optional(),
  price: z.number().positive('Price must be positive'),
});

// PATCH: Buy more shares or sell shares
export const PATCH = validate(tradeSchema)(
  async (request: Request, data: z.infer<typeof tradeSchema>, ctx?: { params?: any }) => {
    const originCheckResponse = checkOrigin(request as any);
    if (originCheckResponse) {
      return originCheckResponse;
    }
    const session = await getServerSession(authOptions);

    if (!session) {
      return unauthorizedResponse();
    }

    try {
      const params = ctx?.params;
      if (!params || !params.stock_id) {
        return createErrorResponse(null, 'Stock ID is required', { status: 400 });
      }

      const stockId = parseInt(params.stock_id, 10);
      if (isNaN(stockId) || stockId <= 0) {
        return createErrorResponse(null, 'Invalid stock ID', { status: 400 });
      }

      const userId = session.user.id;
      const { action, shares: sharesToTrade, price } = data;

      // Verify user owns this stock
      const [existingPosition] = await executeRawQuery(
        'SELECT shares, purchase_price FROM user_stocks WHERE user_id = ? AND stock_id = ? AND is_purchased = 1',
        [userId, stockId]
      );

      if (!Array.isArray(existingPosition) || existingPosition.length === 0) {
        return createErrorResponse(null, 'Position not found', { status: 404 });
      }

      const position = existingPosition[0];
      const currentShares = parseFloat(position.shares);
      const currentPrice = parseFloat(position.purchase_price);

      if (action === 'buy') {
        if (!sharesToTrade) {
          return createErrorResponse(null, 'Shares required for buy action', { status: 400 });
        }

        // Calculate new weighted average price
        const newAvgPrice = (currentShares * currentPrice + sharesToTrade * price) / (currentShares + sharesToTrade);

        await executeRawQuery(
          `UPDATE user_stocks 
           SET shares = shares + ?, 
               purchase_price = ?, 
               last_transaction_date = NOW(),
               is_active = 1
           WHERE user_id = ? AND stock_id = ? AND is_purchased = 1`,
          [sharesToTrade, newAvgPrice, userId, stockId]
        );

        return NextResponse.json(
          {
            status: 'success',
            shares: currentShares + sharesToTrade,
            purchase_price: newAvgPrice,
            last_transaction_date: new Date().toISOString(),
          },
          { status: 200 }
        );
      } else if (action === 'sell_partial') {
        if (!sharesToTrade) {
          return createErrorResponse(null, 'Shares required for sell_partial action', { status: 400 });
        }

        if (sharesToTrade > currentShares) {
          return createErrorResponse(null, 'Cannot sell more shares than you own', { status: 400 });
        }

        const realizedGain = (price - currentPrice) * sharesToTrade;
        const realizedGainPct = (realizedGain / (currentPrice * sharesToTrade)) * 100;

        await executeRawQuery(
          `UPDATE user_stocks 
           SET shares = shares - ?, 
               last_transaction_date = NOW()
           WHERE user_id = ? AND stock_id = ? AND is_purchased = 1`,
          [sharesToTrade, userId, stockId]
        );

        return NextResponse.json(
          {
            status: 'success',
            shares_remaining: currentShares - sharesToTrade,
            shares_sold: sharesToTrade,
            realized_gain: realizedGain,
            realized_gain_pct: Math.round(realizedGainPct * 100) / 100,
            message: `Sold ${sharesToTrade} shares. Realized gain: ${realizedGain >= 0 ? '+' : ''}$${Math.round(realizedGain * 100) / 100} (${realizedGainPct >= 0 ? '+' : ''}${Math.round(realizedGainPct * 100) / 100}%)`,
          },
          { status: 200 }
        );
      } else if (action === 'sell_all') {
        const realizedGain = (price - currentPrice) * currentShares;
        const realizedGainPct = (realizedGain / (currentPrice * currentShares)) * 100;

        await executeRawQuery(
          `UPDATE user_stocks 
           SET shares = 0, 
               is_active = 1,
               is_purchased = 0, 
               last_transaction_date = NOW()
           WHERE user_id = ? AND stock_id = ? AND is_purchased = 1`,
          [userId, stockId]
        );

        return NextResponse.json(
          {
            status: 'success',
            shares_remaining: 0,
            shares_sold: currentShares,
            realized_gain: realizedGain,
            realized_gain_pct: Math.round(realizedGainPct * 100) / 100,
            message: `Sold all ${currentShares} shares. Realized gain: ${realizedGain >= 0 ? '+' : ''}$${Math.round(realizedGain * 100) / 100} (${realizedGainPct >= 0 ? '+' : ''}${Math.round(realizedGainPct * 100) / 100}%)`,
          },
          { status: 200 }
        );
      }

      return createErrorResponse(null, 'Invalid action', { status: 400 });
    } catch (error: any) {
      logger.error('Failed to execute trade:', error);
      return createErrorResponse(error, 'Failed to execute trade', { status: 500 });
    }
  }
);

export async function PUT(
  request: Request,
  { params }: { params: { stock_id: string } }
) {
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  const session = await getServerSession(authOptions);

  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const stockId = params.stock_id;

    // Validate stock_id is a positive integer
    const parsedId = parseInt(stockId, 10);
    if (!stockId || isNaN(parsedId) || parsedId <= 0 || !Number.isInteger(parsedId)) {
      return createErrorResponse(null, 'Invalid stock ID', { status: 400 });
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
      return createErrorResponse(null, 'Stock not found or not owned by user', { status: 404 });
    }

    return NextResponse.json({ message: 'Stock sold successfully (moved to watchlist)' }, { status: 200 });

  } catch (error: any) {
    logger.error("Failed to sell stock:", error);
    return createErrorResponse(error, 'Failed to sell stock', { status: 500 });
  }
}
