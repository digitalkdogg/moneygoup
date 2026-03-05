
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
    // 1. Get latest dates for each category to handle sync timing offsets
    const [stockDateRows] = await executeRawQuery('SELECT MAX(snapshot_date) as d FROM recommended_stocks', []);
    const [marketDateRows] = await executeRawQuery('SELECT MAX(snapshot_date) as d FROM recommended_markets', []);
    const [etfDateRows] = await executeRawQuery('SELECT MAX(snapshot_date) as d FROM hot_etfs', []);

    const stockDate = (stockDateRows as any[])[0]?.d;
    const marketDate = (marketDateRows as any[])[0]?.d;
    const etfDate = (etfDateRows as any[])[0]?.d;

    if (!stockDate && !marketDate && !etfDate) {
      return NextResponse.json({
        hot_stocks: [],
        hot_ai_tech_stocks: [],
        hot_markets: [],
        hot_ai_sectors: [],
        hot_etfs: []
      });
    }

    // 2. Fetch Stocks
    let allStocks: any[] = [];
    if (stockDate) {
      const [rows] = await executeRawQuery(
        'SELECT * FROM recommended_stocks WHERE snapshot_date = ? ORDER BY gps_score DESC',
        [stockDate]
      );
      allStocks = rows as any[];
    }

    // 3. Fetch Markets
    let allMarkets: any[] = [];
    if (marketDate) {
      const [rows] = await executeRawQuery(
        'SELECT * FROM recommended_markets WHERE snapshot_date = ? ORDER BY average_sentiment DESC',
        [marketDate]
      );
      allMarkets = rows as any[];
    }

    // 4. Fetch ETFs
    let allEtfs: any[] = [];
    if (etfDate) {
      const [rows] = await executeRawQuery(
        'SELECT * FROM hot_etfs WHERE snapshot_date = ? AND etf_gps_score >= 55 ORDER BY etf_gps_score DESC',
        [etfDate]
      );
      allEtfs = rows as any[];
    }

    return NextResponse.json({
      hot_stocks: allStocks.filter(s => s.type === 'hot_stocks'),
      hot_ai_tech_stocks: allStocks.filter(s => s.type === 'hot_ai_tech_stocks'),
      hot_markets: allMarkets.filter(m => m.type === 'hot_markets'),
      hot_ai_sectors: allMarkets.filter(m => m.type === 'hot_ai_sectors'),
      hot_etfs: allEtfs
    });

  } catch (error) {
    console.error('Error fetching DeepMoney picks:', error);
    return NextResponse.json(
      { message: 'Internal Server Error', error: (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
