import { NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';
import { validate } from '@/utils/validation';
import { checkOrigin } from '@/utils/originCheck';
import { getBrandColorFromScript } from '@/utils/brandColor';
import { LimitService } from '@/utils/limitService';
import { checkApprovalGuard } from '@/utils/approvalStatus';

const logger = createLogger('api/user/stocks');

const purchaseStockSchema = z.object({
  stock_id: z.number().int().positive('Stock ID must be a positive integer'),
  shares: z.number().positive('Shares must be a positive number'),
  purchase_price: z.number().positive('Purchase price must be a positive number'),
});

async function enrichStockBrand(stockId: number): Promise<{ brandColor: string; source: string } | null> {
  logger.info(`enrichStockBrand: Starting for stockId ${stockId}`);
  try {
    const [rows] = await executeRawQuery(
      'SELECT symbol, company_name FROM stocks WHERE id = ? LIMIT 1',
      [stockId],
    );

    const stock = Array.isArray(rows) && rows.length > 0 ? (rows[0] as { symbol?: string; company_name?: string }) : null;
    if (!stock?.symbol || !stock?.company_name) {
      logger.warn(`enrichStockBrand: Stock not found or incomplete for ID ${stockId}`, { rows });
      return null;
    }

    logger.info(`enrichStockBrand: Found stock ${stock.symbol} (${stock.company_name})`);

    const brandResult = await getBrandColorFromScript(stock.symbol, stock.company_name);
    if (!brandResult?.brand_color) {
      logger.warn(`enrichStockBrand: No brand color result from script for ${stock.symbol}`);
      return null;
    }

    try {
      await executeRawQuery(
        `
        INSERT INTO stock_brand (ticker, company_name, primary_color)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
          company_name = VALUES(company_name),
          primary_color = VALUES(primary_color)
        `,
        [stock.symbol, stock.company_name, brandResult.brand_color],
      );
    } catch (dbError) {
      logger.warn(`enrichStockBrand: DB save failed for ${stock.symbol}`, { error: dbError });
      // We can still return the color even if DB save fails
    }

    return { brandColor: brandResult.brand_color, source: brandResult.source };
  } catch (error) {
    logger.error('enrichStockBrand: Unexpected failure', { error: error as Error });
    return null;
  }
}

export const POST = validate(purchaseStockSchema)(
  async (request: Request, data: z.infer<typeof purchaseStockSchema>) => {
    const originCheckResponse = checkOrigin(request as any);
    if (originCheckResponse) {
      return originCheckResponse;
    }

    try {
      const session = await getServerSession(authOptions);

      if (!session) {
        return unauthorizedResponse();
      }

      const { stock_id, shares, purchase_price } = data;
      const userId = session.user.id;
      const userRole = (session.user as any).role || 'user';
      const isPurchased = 1;

      const approvalOutcome = await checkApprovalGuard(userId);
      if (!approvalOutcome.allowed) {
        logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
        return NextResponse.json(
          { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
          { status: 403 }
        );
      }

      // 0. Check limits
      // First, check if user already has an active portfolio position for this stock
      const [existingPosition]: any = await executeRawQuery(
        'SELECT 1 FROM user_stocks WHERE user_id = ? AND stock_id = ? AND is_purchased = 1 AND is_active = 1',
        [userId, stock_id]
      );

      const alreadyHasPosition = Array.isArray(existingPosition) && existingPosition.length > 0;

      if (!alreadyHasPosition) {
        const limitCheck = await LimitService.canAddPortfolioPosition(userId, userRole);
        if (!limitCheck.allowed) {
          return NextResponse.json(
            {
              code: 'LIMIT_EXCEEDED',
              dimension: 'portfolio',
              allowed: limitCheck.max,
              current: limitCheck.current,
              message: `Portfolio limit exceeded. Your current limit is ${limitCheck.max} positions.`
            },
            { status: 403 }
          );
        }
      }

      const query = `
        INSERT INTO user_stocks (user_id, stock_id, shares, purchase_price, is_purchased, initial_purchase_date, last_transaction_date, is_active, average_cost_basis, first_purchase_date)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 1, ?, NOW())
        ON DUPLICATE KEY UPDATE
          purchase_price = ((purchase_price * shares) + (VALUES(purchase_price) * VALUES(shares))) / (shares + VALUES(shares)),
          average_cost_basis = ((COALESCE(average_cost_basis, purchase_price) * shares) + (VALUES(purchase_price) * VALUES(shares))) / (shares + VALUES(shares)),
          shares = shares + VALUES(shares),
          is_purchased = VALUES(is_purchased),
          initial_purchase_date = IFNULL(initial_purchase_date, NOW()),
          first_purchase_date = IFNULL(first_purchase_date, NOW()),
          last_transaction_date = NOW(),
          is_active = 1;
      `;

      await executeRawQuery(query, [userId, stock_id, shares, purchase_price, isPurchased, purchase_price]);

      await executeRawQuery(
        `INSERT INTO portfolio_transactions (user_id, stock_id, transaction_type, shares, price_per_share, total_amount, fees, transaction_date)
         VALUES (?, ?, 'buy', ?, ?, ?, 0, NOW())`,
        [userId, stock_id, shares, purchase_price, shares * purchase_price]
      );

      // Fire-and-forget: the brand-color script can take several seconds to
      // hit the website + Wikidata, and the client doesn't read its result
      // from this response. Run it without blocking the HTTP reply.
      void enrichStockBrand(stock_id).catch((error) => {
        logger.warn('Background brand enrichment failed', { stockId: stock_id, error });
      });

      return NextResponse.json(
        { message: 'Stock purchased successfully' },
        { status: 201 },
      );
    } catch (error: any) {
      logger.error('Failed to purchase stock:', { error });
      return createErrorResponse(error, 'Failed to purchase stock', { status: 500 });
    }
  },
);