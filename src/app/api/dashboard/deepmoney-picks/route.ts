
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';
import { getGpsLabel } from '@/utils/gps';
import YahooFinance from 'yahoo-finance2';

const ETF_GPS_THRESHOLD = 75;
const logger = createLogger('api/dashboard/deepmoney-picks');

function getStockGpsThreshold(): number {
  const val = process.env.GPS_DEEPMONEY_MIN_SCORE
  if (!val) return 65
  const parsed = parseFloat(val)
  return isNaN(parsed) ? 65 : parsed
}
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  const approvalOutcome = await checkApprovalGuard(userId);
  if (!approvalOutcome.allowed) {
    logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
    return NextResponse.json(
      { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
      { status: 403 }
    );
  }

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
        etf_holdings: [],
      });
    }

    // 2. Fetch Stocks — filtered by GPS minimum threshold, sorted by GPS score
    const stockGpsMin = getStockGpsThreshold();
    let allStocks: any[] = [];
    if (stockDate) {
      const [rows] = await executeRawQuery(
        `SELECT id, type, ticker, company_name, current_price, gps_score, gps_breakdown, classification,
                analyst_upside_pct, revenue_growth_yoy, gross_margin_pct, rd_spend_pct,
                market_cap_m, mention_count, discovery_source, trading_signal,
                trading_signal_score, upcoming_earnings, snapshot_date,
                trailing_pe, price_to_book, metric_value, metric_label
         FROM recommended_stocks
         WHERE snapshot_date = ? AND gps_score >= ?
         ORDER BY gps_score DESC`,
        [stockDate, stockGpsMin]
      );
      allStocks = rows as any[];
    }

    // 3. Fetch surfaced ETF holdings
    let etfHoldings: any[] = [];
    if (stockDate) {
      const [rows] = await executeRawQuery(
        `SELECT id, type, ticker, company_name, gps_score, gps_breakdown,
                parent_etf_ticker, holding_percent, bearish_signal,
                metric_value, metric_label, snapshot_date
         FROM recommended_stocks
         WHERE snapshot_date = ? AND type = 'etf_holding'
         ORDER BY gps_score DESC`,
        [stockDate]
      );
      // Deduplicate by ticker — a holding may appear in multiple ETFs.
      // Rows are ordered by gps_score DESC, so the first occurrence is the best score.
      const seen = new Set<string>();
      etfHoldings = (rows as any[]).filter(h => {
        const t = (h.ticker as string)?.toUpperCase();
        if (!t || seen.has(t)) return false;
        seen.add(t);
        return true;
      });
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
            recommendationLabel: stock.gps_score != null ? getGpsLabel(parseFloat(stock.gps_score)) : null,
          };
        } catch (e) {
          logger.error(`Error enriching stock ${stock.ticker}`, { error: e });
          return {
            ...stock,
            changeAmount: null,
            changePercent: null,
            recommendationLabel: stock.gps_score != null ? getGpsLabel(parseFloat(stock.gps_score)) : null,
          };
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
          logger.error(`Error enriching ETF ${etf.ticker}`, { error: e });
          return { ...etf, changeAmount: null, changePercent: null };
        }
      })
    );
    return NextResponse.json({
      hot_stocks: enrichedHotStocks,
      hot_etfs: enrichedHotEtfs,
      etf_holdings: etfHoldings,
    });

  } catch (error) {
    logger.error('Error fetching DeepMoney picks', { error });
    return createErrorResponse(error, 'Failed to fetch DeepMoney picks');
  }
}
