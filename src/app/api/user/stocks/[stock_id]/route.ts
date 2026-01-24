// src/app/api/user/stocks/[stock_id]/route.ts
import { NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';

export async function DELETE(
  request: Request,
  { params }: { params: { stock_id: string } }
) {
  let connection;
  try {
    const stockId = params.stock_id;

    // Validate stock_id is a positive integer
    const parsedId = parseInt(stockId, 10);
    if (!stockId || isNaN(parsedId) || parsedId <= 0 || !Number.isInteger(parsedId)) {
      return NextResponse.json({ error: 'Invalid stock ID' }, { status: 400 });
    }

    // For now, we'll hardcode the user_id to 1 as there is no auth system
    const userId = 1;

    connection = await getDbConnection();
    
    // Delete all entries for this user and stock
    const query = `
      DELETE FROM user_stocks
      WHERE user_id = ? AND stock_id = ?;
    `;

    const [result] = await connection.execute(query, [userId, parsedId]);
    await connection.end();

    if ((result as any).affectedRows === 0) {
      return NextResponse.json(
        { error: 'Stock not found or not owned by user' },
        { status: 404 }
      );
    }

    return NextResponse.json({ message: 'Stock sold successfully' }, { status: 200 });

  } catch (error) {
    console.error("Failed to sell stock:", error);
    if (connection) {
      await connection.end();
    }
    // Don't expose database error details to client
    return NextResponse.json({ error: 'Failed to sell stock' }, { status: 500 });
  }
}
