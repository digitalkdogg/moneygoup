
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import YahooFinance from 'yahoo-finance2';

const ETF_GPS_THRESHOLD = 75;
const yahooFinance = new YahooFinance();

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

    const enrichedHotStocks = await Promise.all(
      allStocks.filter(s => s.type === 'hot_stocks').map(async (stock: any) => {
        try {
          const summary = await yahooFinance.quoteSummary(stock.ticker, { modules: ['summaryDetail'] }).catch(() => null);
          const rawPreviousClose = summary?.summaryDetail?.previousClose;
          const previousClose = typeof rawPreviousClose === 'number'
            ? rawPreviousClose
            : (rawPreviousClose && typeof rawPreviousClose === 'object' ? (rawPreviousClose as any).raw : null);
          const currentPrice = stock.current_price;
          const changeAmount = previousClose !== undefined && previousClose !== null ? currentPrice - previousClose : null;
          const changePercent = previousClose !== undefined && previousClose !== null && previousClose !== 0 ? (changeAmount! / previousClose) * 100 : null;

          return {
            ...stock,
            changeAmount,
            changePercent,
          };
        } catch (e) {
          console.error(`Error enriching stock ${stock.ticker}:`, e);
          return { ...stock, changeAmount: null, changePercent: null };
        }
      })
    );

    const enrichedHotEtfs = await Promise.all(
      allEtfs.map(async (etf: any) => {
        try {
          const summary = await yahooFinance.quoteSummary(etf.ticker, { modules: ['summaryDetail'] }).catch(() => null);
          const rawPreviousClose = summary?.summaryDetail?.previousClose;
          const previousClose = typeof rawPreviousClose === 'number'
            ? rawPreviousClose
            : (rawPreviousClose && typeof rawPreviousClose === 'object' ? (rawPreviousClose as any).raw : null);
          const currentPrice = etf.current_price;
          const changeAmount = previousClose !== undefined && previousClose !== null ? currentPrice - previousClose : null;
          const changePercent = previousClose !== undefined && previousClose !== null && previousClose !== 0 ? (changeAmount! / previousClose) * 100 : null;

          return {
            ...etf,
            changeAmount,
            changePercent,
          };
        } catch (e) {
          console.error(`Error enriching ETF ${etf.ticker}:`, e);
          return { ...etf, changeAmount: null, changePercent: null };
        }
      })
    );
    return NextResponse.json({
      hot_stocks: enrichedHotStocks,
      hot_etfs: enrichedHotEtfs,
    });

  } catch (error) {
    console.error('Error fetching DeepMoney picks:', error);
    return NextResponse.json(
      { message: 'Internal Server Error', error: (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
