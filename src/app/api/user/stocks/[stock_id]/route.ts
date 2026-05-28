import { NextResponse } from 'next/server';
import { remove, update, executeRawQuery } from '@/utils/databaseHelper'; // Add executeRawQuery
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';
import { validate } from '@/utils/validation';
import { checkOrigin } from '@/utils/originCheck'; // Add this import
import { checkApprovalGuard } from '@/utils/approvalStatus';

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
      const params = await ctx?.params;
      if (!params || !params.stock_id) {
        return createErrorResponse(null, 'Stock ID is required', { status: 400 });
      }

      const stockId = parseInt(params.stock_id, 10);
      if (isNaN(stockId) || stockId <= 0) {
        return createErrorResponse(null, 'Invalid stock ID', { status: 400 });
      }

      const userId = session.user.id;
      const { action, shares: sharesToTrade, price } = data;

      const approvalOutcome = await checkApprovalGuard(userId);
      if (!approvalOutcome.allowed) {
        logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
        return NextResponse.json(
          { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
          { status: 403 }
        );
      }

      // Verify user owns this stock
      const [existingPosition] = await executeRawQuery(
        'SELECT shares, purchase_price, average_cost_basis FROM user_stocks WHERE user_id = ? AND stock_id = ? AND is_purchased = 1',
        [userId, stockId]
      );

      if (!Array.isArray(existingPosition) || existingPosition.length === 0) {
        return createErrorResponse(null, 'Position not found', { status: 404 });
      }

      const position = existingPosition[0];
      const currentShares = parseFloat(position.shares);
      const currentPrice = parseFloat(position.purchase_price);
      const currentAvgCost = position.average_cost_basis != null
        ? parseFloat(position.average_cost_basis)
        : currentPrice;

      if (action === 'buy') {
        if (!sharesToTrade) {
          return createErrorResponse(null, 'Shares required for buy action', { status: 400 });
        }

        const newAvgPrice = (currentShares * currentPrice + sharesToTrade * price) / (currentShares + sharesToTrade);
        const newAvgCost = (currentShares * currentAvgCost + sharesToTrade * price) / (currentShares + sharesToTrade);

        await executeRawQuery(
          `UPDATE user_stocks
           SET shares = shares + ?,
               purchase_price = ?,
               average_cost_basis = ?,
               first_purchase_date = IFNULL(first_purchase_date, NOW()),
               last_transaction_date = NOW(),
               is_active = 1
           WHERE user_id = ? AND stock_id = ? AND is_purchased = 1`,
          [sharesToTrade, newAvgPrice, newAvgCost, userId, stockId]
        );

        await executeRawQuery(
          `INSERT INTO portfolio_transactions (user_id, stock_id, transaction_type, shares, price_per_share, total_amount, fees, transaction_date)
           VALUES (?, ?, 'buy', ?, ?, ?, 0, NOW())`,
          [userId, stockId, sharesToTrade, price, sharesToTrade * price]
        );

        return NextResponse.json(
          {
            status: 'success',
            shares: currentShares + sharesToTrade,
            purchase_price: newAvgPrice,
            average_cost_basis: newAvgCost,
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

        const realizedGain = (price - currentAvgCost) * sharesToTrade;
        const realizedGainPct = (realizedGain / (currentAvgCost * sharesToTrade)) * 100;

        await executeRawQuery(
          `UPDATE user_stocks
           SET shares = shares - ?,
               last_transaction_date = NOW()
           WHERE user_id = ? AND stock_id = ? AND is_purchased = 1`,
          [sharesToTrade, userId, stockId]
        );

        await executeRawQuery(
          `INSERT INTO portfolio_transactions (user_id, stock_id, transaction_type, shares, price_per_share, total_amount, fees, transaction_date)
           VALUES (?, ?, 'sell', ?, ?, ?, 0, NOW())`,
          [userId, stockId, sharesToTrade, price, sharesToTrade * price]
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
        const realizedGain = (price - currentAvgCost) * currentShares;
        const realizedGainPct = (realizedGain / (currentAvgCost * currentShares)) * 100;

        await executeRawQuery(
          `UPDATE user_stocks
           SET shares = 0,
               is_active = 1,
               is_purchased = 0,
               last_transaction_date = NOW()
           WHERE user_id = ? AND stock_id = ? AND is_purchased = 1`,
          [userId, stockId]
        );

        await executeRawQuery(
          `INSERT INTO portfolio_transactions (user_id, stock_id, transaction_type, shares, price_per_share, total_amount, fees, transaction_date)
           VALUES (?, ?, 'sell', ?, ?, ?, 0, NOW())`,
          [userId, stockId, currentShares, price, currentShares * price]
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
      logger.error('Failed to execute trade:', { error });
      return createErrorResponse(error, 'Failed to execute trade', { status: 500 });
    }
  }
);

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ stock_id: string }> }
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
    const resolvedParams = await params;
    const stockId = resolvedParams.stock_id;

    // Validate stock_id is a positive integer
    const parsedId = parseInt(stockId, 10);
    if (!stockId || isNaN(parsedId) || parsedId <= 0 || !Number.isInteger(parsedId)) {
      return createErrorResponse(null, 'Invalid stock ID', { status: 400 });
    }

    const userId = session.user.id;

    const approvalOutcome = await checkApprovalGuard(userId);
    if (!approvalOutcome.allowed) {
      logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
      return NextResponse.json(
        { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
        { status: 403 }
      );
    }

    // Fetch current position before clearing it so we can log the transaction
    const [currentRows] = await executeRawQuery(
      'SELECT shares, COALESCE(average_cost_basis, purchase_price) as cost_basis FROM user_stocks WHERE user_id = ? AND stock_id = ? AND is_purchased = 1',
      [userId, parsedId]
    ) as any[];
    const currentPosition = Array.isArray(currentRows) && currentRows.length > 0 ? currentRows[0] : null;

    // Update user_stocks to reflect "sold" state (i.e., move back to watchlist)
    const affectedRows = await update(
      'user_stocks',
      { is_purchased: 0, shares: 0, purchase_price: 0 },
      { user_id: userId, stock_id: parsedId }
    );

    if (affectedRows === 0) {
      return createErrorResponse(null, 'Stock not found or not owned by user', { status: 404 });
    }

    if (currentPosition && parseFloat(currentPosition.shares) > 0) {
      const soldShares = parseFloat(currentPosition.shares);
      const costBasis = parseFloat(currentPosition.cost_basis) || 0;
      await executeRawQuery(
        `INSERT INTO portfolio_transactions (user_id, stock_id, transaction_type, shares, price_per_share, total_amount, fees, transaction_date)
         VALUES (?, ?, 'sell', ?, ?, ?, 0, NOW())`,
        [userId, parsedId, soldShares, costBasis, soldShares * costBasis]
      );
    }

    return NextResponse.json({ message: 'Stock sold successfully (moved to watchlist)' }, { status: 200 });

  } catch (error: any) {
    logger.error("Failed to sell stock:", { error });
    return createErrorResponse(error, 'Failed to sell stock', { status: 500 });
  }
}
