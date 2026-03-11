
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
        hot_etfs: [],
        undervalued_large_caps: [],
        breakout_candidates: [],
        insider_activity: [],
        analyst_favorites: [],
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
        'SELECT * FROM hot_etfs WHERE snapshot_date = ? AND etf_gps_score >= ? ORDER BY etf_gps_score DESC',
        [etfDate, ETF_GPS_THRESHOLD]
      );
      allEtfs = rows as any[];
    }

    // 5. Map the new screener types into the RecommendedStock shape the dashboard expects
    const mapToRecommendedShape = (s: any) => ({
      symbol:              s.ticker,
      name:                s.company_name,
      regularMarketPrice:  s.current_price ? parseFloat(s.current_price) : null,
      marketCap:           s.market_cap_m ? parseFloat(s.market_cap_m) * 1e6 : null,
      metric:              s.metric_value ? parseFloat(s.metric_value) : null,
      metricLabel:         s.metric_label,
    });

    const mapToUndervaluedShape = (s: any) => ({
      symbol:              s.ticker,
      name:                s.company_name,
      regularMarketPrice:  s.current_price ? parseFloat(s.current_price) : null,
      marketCap:           s.market_cap_m ? parseFloat(s.market_cap_m) * 1e6 : null,
      trailingPE:          s.trailing_pe ? parseFloat(s.trailing_pe) : null,
      priceToBook:         s.price_to_book ? parseFloat(s.price_to_book) : null,
    });

    return NextResponse.json({
      // Existing — shape unchanged so DeepMoneyPicksSection keeps working
      hot_stocks:         allStocks.filter(s => s.type === 'hot_stocks'),
      hot_ai_tech_stocks: allStocks.filter(s => s.type === 'hot_ai_tech_stocks'),
      hot_markets:        allMarkets.filter(m => m.type === 'hot_markets'),
      hot_ai_sectors:     allMarkets.filter(m => m.type === 'hot_ai_sectors'),
      hot_etfs:           allEtfs,

      // New — match exactly what Dashboard.tsx state variables expect
      undervalued_large_caps: allStocks
        .filter(s => s.type === 'undervalued_large_caps')
        .map(mapToUndervaluedShape),
      breakout_candidates: allStocks
        .filter(s => s.type === 'breakout_candidates')
        .map(mapToRecommendedShape),
      insider_activity: allStocks
        .filter(s => s.type === 'insider_activity')
        .map(mapToRecommendedShape),
      analyst_favorites: allStocks
        .filter(s => s.type === 'analyst_favorites')
        .map(mapToRecommendedShape),
    });

  } catch (error) {
    console.error('Error fetching DeepMoney picks:', error);
    return NextResponse.json(
      { message: 'Internal Server Error', error: (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
