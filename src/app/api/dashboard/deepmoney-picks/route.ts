
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { ETF_GPS_THRESHOLD } from '@/app/api/prediction/deepmoney/config';

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  try {
    // 1. Get latest dates for each category to handle sync timing offsets
    const [stockDateRows] = await executeRawQuery('SELECT MAX(snapshot_date) as d FROM recommended_stocks', []);
    const [etfDateRows] = await executeRawQuery('SELECT MAX(snapshot_date) as d FROM hot_etfs', []);

    const stockDate = (stockDateRows as any[])[0]?.d;
    const etfDate = (etfDateRows as any[])[0]?.d;

    if (!stockDate && !etfDate) {
      return NextResponse.json({
        hot_stocks: [],
        hot_etfs: [],
      });
    }

    // 2. Fetch Stocks
    let allStocks: any[] = [];
    if (stockDate) {
      const [rows] = await executeRawQuery(
        `SELECT id, type, ticker, company_name, current_price, gps_score, classification,
                analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct,
                market_cap_m, mention_count, discovery_source, trading_signal,
                trading_signal_score, upcoming_earnings, snapshot_date,
                trailing_pe, price_to_book, metric_value, metric_label
         FROM recommended_stocks
         WHERE snapshot_date = ?
         ORDER BY gps_score DESC`,
        [stockDate]
      );
      allStocks = rows as any[];
    }

    // 3. Fetch ETFs
    let allEtfs: any[] = [];
    if (etfDate) {
      const [rows] = await executeRawQuery(
        'SELECT * FROM hot_etfs WHERE snapshot_date = ? AND etf_gps_score >= ? ORDER BY etf_gps_score DESC',
        [etfDate, ETF_GPS_THRESHOLD]
      );
      allEtfs = rows as any[];
    }

    return NextResponse.json({
      // Existing — shape unchanged so DeepMoneyPicksSection keeps working
      hot_stocks:         allStocks.filter(s => s.type === 'hot_stocks'),
      hot_etfs:           allEtfs,
    });

  } catch (error) {
    console.error('Error fetching DeepMoney picks:', error);
    return NextResponse.json(
      { message: 'Internal Server Error', error: (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
