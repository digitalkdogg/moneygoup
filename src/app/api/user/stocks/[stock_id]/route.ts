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

    // For now, we'll hardcode the user_id to 1 as there is no auth system
    const userId = 1;

    connection = await getDbConnection();
    
    // Delete all entries for this user and stock
    const query = `
      DELETE FROM user_stocks
      WHERE user_id = ? AND stock_id = ?;
    `;

    const [result] = await connection.execute(query, [userId, stockId]);
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
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Failed to sell stock', details: errorMessage }, { status: 500 });
  }
}
