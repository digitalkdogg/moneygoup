// src/app/api/user/stocks/route.ts
import { NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';

export async function POST(request: Request) {
  let connection;
  try {
    const { stock_id, shares, purchase_price } = await request.json();

    // Basic validation
    if (!stock_id || !shares || !purchase_price) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // For now, we'll hardcode the user_id to 1 as there is no auth system
    const userId = 1;
    const isPurchased = 1;

    connection = await getDbConnection();
    
    const query = `
      INSERT INTO user_stocks (user_id, stock_id, shares, purchase_price, is_purchased)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        shares = shares + VALUES(shares),
        purchase_price = ((purchase_price * shares) + (VALUES(purchase_price) * VALUES(shares))) / (shares + VALUES(shares));
    `;

    await connection.execute(query, [userId, stock_id, shares, purchase_price, isPurchased]);
    await connection.end();

    return NextResponse.json({ message: 'Stock purchased successfully' }, { status: 201 });

  } catch (error) {
    console.error("Failed to purchase stock:", error);
    if (connection) {
      await connection.end();
    }
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Failed to purchase stock', details: errorMessage }, { status: 500 });
  }
}
