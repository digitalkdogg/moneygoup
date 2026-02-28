
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  try {
    // 1. Get latest snapshot date
    const [dateRows] = await executeRawQuery(
      'SELECT MAX(snapshot_date) as latestDate FROM recommended_stocks', 
      []
    );
    const latestDate = (dateRows as any[])[0]?.latestDate;

    if (!latestDate) {
      return NextResponse.json({
        hot_stocks: [],
        hot_ai_tech_stocks: [],
        hot_markets: [],
        hot_ai_sectors: []
      });
    }

    // 2. Fetch Stocks
    const [stockRows] = await executeRawQuery(
      'SELECT * FROM recommended_stocks WHERE snapshot_date = ? ORDER BY gps_score DESC',
      [latestDate]
    );
    const allStocks = stockRows as any[];

    // 3. Fetch Markets
    const [marketRows] = await executeRawQuery(
      'SELECT * FROM recommended_markets WHERE snapshot_date = ? ORDER BY average_sentiment DESC',
      [latestDate]
    );
    const allMarkets = marketRows as any[];

    return NextResponse.json({
      hot_stocks: allStocks.filter(s => s.type === 'hot_stocks'),
      hot_ai_tech_stocks: allStocks.filter(s => s.type === 'hot_ai_tech_stocks'),
      hot_markets: allMarkets.filter(m => m.type === 'hot_markets'),
      hot_ai_sectors: allMarkets.filter(m => m.type === 'hot_ai_sectors')
    });

  } catch (error) {
    console.error('Error fetching DeepMoney picks:', error);
    return NextResponse.json(
      { message: 'Internal Server Error', error: (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
