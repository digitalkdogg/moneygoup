// src/app/api/user/stocks/[stock_id]/route.ts
import { NextResponse } from 'next/server';
import { remove } from '@/utils/databaseHelper';

export async function DELETE(
  request: Request,
  { params }: { params: { stock_id: string } }
) {
  try {
    const stockId = params.stock_id;

    // Validate stock_id is a positive integer
    const parsedId = parseInt(stockId, 10);
    if (!stockId || isNaN(parsedId) || parsedId <= 0 || !Number.isInteger(parsedId)) {
      return NextResponse.json({ error: 'Invalid stock ID' }, { status: 400 });
    }

    // For now, we'll hardcode the user_id to 1 as there is no auth system
    const userId = 1;
    
    const affectedRows = await remove('user_stocks', { user_id: userId, stock_id: parsedId });

    if (affectedRows === 0) {
      return NextResponse.json(
        { error: 'Stock not found or not owned by user' },
        { status: 404 }
      );
    }

    return NextResponse.json({ message: 'Stock sold successfully' }, { status: 200 });

  } catch (error) {
    console.error("Failed to sell stock:", error);
    // Don't expose database error details to client
    return NextResponse.json({ error: 'Failed to sell stock' }, { status: 500 });
  }
}
