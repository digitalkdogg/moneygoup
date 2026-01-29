import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse } from '@/utils/errorResponse';
import YahooFinance from 'yahoo-finance2';

const logger = createLogger('api/dashboard/get');
const yahooFinance = new YahooFinance();

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  const session = await getServerSession(authOptions);

  if (!session) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  try {
    const userId = session.user?.id;
    if (!userId) {
      logger.error('Session user ID is undefined or null for an authenticated session.');
      return new NextResponse(JSON.stringify({ message: 'Unauthorized: User ID missing or invalid from session.' }), { status: 401 });
    }

    // 1. Fetch all stock symbols the user is tracking
    const [userStocksResult] = await executeRawQuery<{ symbol: string; stock_id: number }[]>(`
        SELECT
            s.symbol,
            s.id AS stock_id
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.id
        WHERE us.user_id = ?
        ORDER BY s.symbol;
    `, [userId]);

    const symbols = userStocksResult.map(stock => stock.symbol);
    const stockIdMap = new Map<string, number>(userStocksResult.map(stock => [stock.symbol, stock.stock_id]));


    if (symbols.length === 0) {
      return NextResponse.json([]); // No stocks to fetch
    }

    // 2. Fetch data for all symbols from Yahoo Finance in one batch call
    const yahooFinanceData = await yahooFinance.quote(symbols);

    // 3. Map the Yahoo Finance data back to include the stock_id and other relevant info
    const combinedData = yahooFinanceData.map(data => ({
      stock_id: stockIdMap.get(data.symbol || '') || null, // Map back the stock_id
      symbol: data.symbol,
      companyName: data.longName || data.shortName || 'N/A',
      price: data.regularMarketPrice || null,
      daily_change: data.regularMarketChange || null,
      marketCap: data.marketCap || null,
      trailingPE: data.trailingPE || null,
      priceToBook: data.priceToBook || null,
      // You can add more fields from yahooFinanceData as needed
    }));

    return NextResponse.json(combinedData);

  } catch (error: any) {
    logger.error("Failed to fetch dashboard data from Yahoo Finance.", error);
    return createErrorResponse(error, 500);
  }
}
