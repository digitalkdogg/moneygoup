import { NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const logger = createLogger('api/user/stocks');

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  try {
    const { stock_id, shares, purchase_price } = await request.json();

    // Basic validation
    if (!stock_id || !shares || !purchase_price) {
      return createErrorResponse('Missing required fields', 400);
    }
    
    const userId = session.user.id;
    const isPurchased = 1;
    
    const query = `
      INSERT INTO user_stocks (user_id, stock_id, shares, purchase_price, is_purchased)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        shares = shares + VALUES(shares),
        purchase_price = ((purchase_price * shares) + (VALUES(purchase_price) * VALUES(shares))) / (shares + VALUES(shares)),
        is_purchased = VALUES(is_purchased);
    `;

    await executeRawQuery(query, [userId, stock_id, shares, purchase_price, isPurchased]);

    return NextResponse.json({ message: 'Stock purchased successfully' }, { status: 201 });

  } catch (error: any) {
    logger.error("Failed to purchase stock:", error);
    return createErrorResponse(error, 500);
  }
}
