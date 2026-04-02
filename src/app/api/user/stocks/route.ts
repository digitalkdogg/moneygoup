import { NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod'; // Add this import
import { validate } from '@/utils/validation'; // Add this import
import { checkOrigin } from '@/utils/originCheck'; // Add this import

const logger = createLogger('api/user/stocks');

// Define schema for input validation
const purchaseStockSchema = z.object({
  stock_id: z.number().int().positive('Stock ID must be a positive integer'),
  shares: z.number().positive('Shares must be a positive number'),
  purchase_price: z.number().positive('Purchase price must be a positive number'),
});

export const POST = validate(purchaseStockSchema)(

  async (request: Request, data: z.infer<typeof purchaseStockSchema>) => {
    const originCheckResponse = checkOrigin(request as any); // Cast to any as NextRequest might not be directly compatible
    if (originCheckResponse) {
      return originCheckResponse;
    }
    try {
      const session = await getServerSession(authOptions);

      if (!session) {
        return unauthorizedResponse();
      }

      // `data` now contains the validated fields
      const { stock_id, shares, purchase_price } = data;
      
      const userId = session.user.id;
      const isPurchased = 1;
      
      const query = `
        INSERT INTO user_stocks (user_id, stock_id, shares, purchase_price, is_purchased, initial_purchase_date, last_transaction_date, is_active)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 1)
        ON DUPLICATE KEY UPDATE
          purchase_price = ((purchase_price * shares) + (VALUES(purchase_price) * VALUES(shares))) / (shares + VALUES(shares)),
          shares = shares + VALUES(shares),
          is_purchased = VALUES(is_purchased),
          initial_purchase_date = IFNULL(initial_purchase_date, NOW()),
          last_transaction_date = NOW(),
          is_active = 1;
      `;

      await executeRawQuery(query, [userId, stock_id, shares, purchase_price, isPurchased]);

      return NextResponse.json({ message: 'Stock purchased successfully' }, { status: 201 });

    } catch (error: any) {
      logger.error("Failed to purchase stock:", error);
      return createErrorResponse(error, 'Failed to purchase stock', { status: 500 });
    }
  }
);
