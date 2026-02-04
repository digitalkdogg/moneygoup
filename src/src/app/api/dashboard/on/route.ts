import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get('ticker');

  if (!ticker) {
    return NextResponse.json({ message: 'Missing ticker parameter' }, { status: 400 });
  }

  const userId = session.user.id;
  const normalizedTicker = ticker.toUpperCase().trim();

  try {
    const query = `
      SELECT EXISTS (
        SELECT 1
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.id
        WHERE us.user_id = ? AND s.symbol = ?
      ) AS isOnWatchlist;
    `;
    const [rows] = await executeRawQuery(query, [userId, normalizedTicker]);
    
    // The result is an array of RowDataPacket, and the EXISTS returns 0 or 1
    const isOnWatchlist = (rows as any[])[0]?.isOnWatchlist === 1;

    return NextResponse.json({ ticker: normalizedTicker, isOnWatchlist });

  } catch (error) {
    console.error('Error checking watchlist status:', error);
    return NextResponse.json(
      { message: 'Internal Server Error', error: (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
