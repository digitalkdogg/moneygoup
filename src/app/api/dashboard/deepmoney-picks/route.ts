
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';
import { getGpsLabel, adjustGpsForHorizon, type GpsBreakdown } from '@/utils/gps';
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy';
import type { HorizonKey } from '@/utils/horizons';
import { resolveEtfHoldingAlgorithm } from '@/utils/etfHoldingPreset';
import YahooFinance from 'yahoo-finance2';

const logger = createLogger('api/dashboard/deepmoney-picks');

function getStockGpsThreshold(): number {
  const val = process.env.GPS_DEEPMONEY_MIN_SCORE
  if (!val) return 65
  const parsed = parseFloat(val)
  return isNaN(parsed) ? 65 : parsed
}

// Dashboard tenure rotation — on by default. Set DASHBOARD_TENURE_ROTATION=off
// in .env.local to fall back to the flat GPS-sorted query.
// When on, the hot_stocks section caps at TENURE_TARGET_CARDS, demotes tickers
// that have been surfaced for TENURE_MAX_DAYS in a row, and holds evicted
// tickers out for TENURE_COOLDOWN_DAYS before re-admitting them. If the fresh
// pool falls below TENURE_MIN_CARDS the section is backfilled from the stale
// pool by GPS so it's never empty.
const TENURE_ROTATION_ENABLED = process.env.DASHBOARD_TENURE_ROTATION !== 'off';
const TENURE_MAX_DAYS      = parseInt(process.env.DASHBOARD_TENURE_MAX_DAYS      || '7',  10);
const TENURE_COOLDOWN_DAYS = parseInt(process.env.DASHBOARD_TENURE_COOLDOWN_DAYS || '5',  10);
const TENURE_TARGET_CARDS  = parseInt(process.env.DASHBOARD_TENURE_TARGET_CARDS  || '12', 10);
const TENURE_MIN_CARDS     = parseInt(process.env.DASHBOARD_TENURE_MIN_CARDS     || '8',  10);

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

    const toDateStr = (v: any) => v instanceof Date ? v.toISOString().slice(0, 10) : v;
    const stockDate = toDateStr((stockDateRows as any[])[0]?.d);
    const etfDate   = toDateStr((etfDateRows as any[])[0]?.d);

    // Resolve user's investment timeframe so we can both label correctly AND
    // patch each card's GPS via adjustGpsForHorizon (same approach as the
    // dashboard recommendations route) instead of serving the 1m baseline.
    const userStrategy = await getUserStrategy(userId).catch(() => DEFAULT_STRATEGY);
    const tfCfg = resolveStrategy(userStrategy).timeframe;
    const timeframeLabel = tfCfg.displayLabel;
    const timeframe = userStrategy.investment_timeframe;
    const sfx = tfCfg.predictedPriceColumn.replace('predicted_price_', '');

    if (!stockDate && !etfDate) {
      return NextResponse.json({
        hot_stocks: [],
        hot_etfs: [],
        etf_holdings: [],
        timeframe,
        timeframe_label: timeframeLabel,
      });
    }

    // 2. Fetch Stocks — filtered by GPS minimum threshold, sorted by GPS score.
    //    When DASHBOARD_TENURE_ROTATION=on, a two-pass fresh-pool + backfill
    //    query replaces the flat GPS sort to rotate stale names off the section.
    const stockGpsMin = getStockGpsThreshold();
    let allStocks: any[] = [];
    if (stockDate) {
      if (TENURE_ROTATION_ENABLED) {
        allStocks = await fetchHotStocksWithRotation(stockDate, stockGpsMin);
      } else {
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
    }

    // 3. Fetch off-market movers — rolling 2-day window so yesterday's movers
    //    stay visible until they age off naturally. Deduplicate by ticker,
    //    keeping the row with the largest absolute move across the window.
    let offMarketMovers: any[] = [];
    if (stockDate) {
      const [moverRows] = await executeRawQuery(
        `SELECT ticker, company_name, current_price, metric_value, metric_label,
                discovery_source, snapshot_date
         FROM recommended_stocks
         WHERE type = 'off_market_mover'
           AND snapshot_date >= CURDATE() - INTERVAL 1 DAY
           AND metric_value > 0
         ORDER BY metric_value DESC`,
        []
      );
      const seen = new Set<string>();
      for (const row of moverRows as any[]) {
        if (!seen.has(row.ticker)) {
          seen.add(row.ticker);
          offMarketMovers.push(row);
        }
      }
    }

    // 4. Fetch surfaced ETF holdings
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

    // 5. Fetch ETFs. The minimum etf_gps_score for a hot_etfs row to render
    // in this widget comes from the same preset that gated qualification at
    // sync time (ETF_HOLDING_ALGORITHM), so the read-side filter agrees with
    // whatever level produced the persisted rows.
    let allEtfs: any[] = [];
    if (etfDate) {
      const etfHoldingAlgorithm = resolveEtfHoldingAlgorithm(process.env.ETF_HOLDING_ALGORITHM);
      const [rows] = await executeRawQuery(
        'SELECT * FROM hot_etfs WHERE snapshot_date = ? AND etf_gps_score >= ? ORDER BY etf_gps_score DESC',
        [etfDate, etfHoldingAlgorithm.etfGpsThreshold]
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
    // Batch-fetch the user's per-horizon change% + confidence for every
    // ticker we're about to show — hot stocks AND ETF holdings. Tickers
    // the user owns or watches will have a row; everything else falls back
    // to the raw 1m baseline. Lets the widget honor the user's timeframe
    // for the tickers it has data for, the same way the portfolio /
    // watchlist / recommendations routes already do.
    const cardTickers = [
      ...enrichedHotStocks.map(s => s.ticker as string),
      ...etfHoldings.map(h => h.ticker as string),
    ].filter(Boolean);
    const horizonByTicker = await fetchHorizonDataForTickers(userId, cardTickers, sfx);

    const adjustedHotStocks = enrichedHotStocks.map(s => applyHorizonAdjustment(s, horizonByTicker, timeframe));
    const adjustedEtfHoldings = etfHoldings.map(h => applyHorizonAdjustment(h, horizonByTicker, timeframe));

    return NextResponse.json({
      hot_stocks: adjustedHotStocks,
      hot_etfs: enrichedHotEtfs,
      etf_holdings: adjustedEtfHoldings,
      off_market_movers: offMarketMovers,
      timeframe,
      timeframe_label: timeframeLabel,
    });

  } catch (error) {
    logger.error('Error fetching DeepMoney picks', { error });
    return createErrorResponse(error, 'Failed to fetch DeepMoney picks');
  }
}

interface HorizonRow { change_pct: number | null; confidence: number | null }

async function fetchHorizonDataForTickers(
  userId: string | number,
  tickers: string[],
  sfx: string,
): Promise<Map<string, HorizonRow>> {
  const out = new Map<string, HorizonRow>();
  if (tickers.length === 0) return out;
  const unique = Array.from(new Set(tickers.map(t => t.toUpperCase())));
  const placeholders = unique.map(() => '?').join(',');
  try {
    const [rows] = await executeRawQuery(
      `SELECT s.symbol,
              usp.predicted_change_pct_${sfx} AS change_pct,
              usp.confidence_score_${sfx}     AS confidence
       FROM user_stock_predictions usp
       JOIN stocks s ON s.id = usp.stock_id
       WHERE usp.user_id = ? AND s.symbol IN (${placeholders})`,
      [userId, ...unique],
    );
    for (const r of rows as Array<{ symbol: string; change_pct: number | null; confidence: number | null }>) {
      out.set((r.symbol as string).toUpperCase(), {
        change_pct: r.change_pct != null ? Number(r.change_pct) : null,
        confidence: r.confidence != null ? Number(r.confidence) : null,
      });
    }
  } catch (err) {
    logger.warn('Failed to fetch per-horizon data for deepmoney-picks adjustment', { error: err });
  }
  return out;
}

function applyHorizonAdjustment<T extends { ticker?: string; gps_score?: number | string | null; gps_breakdown?: unknown }>(
  card: T,
  horizonByTicker: Map<string, HorizonRow>,
  horizon: HorizonKey,
): T {
  const ticker = (card.ticker || '').toUpperCase();
  const row = horizonByTicker.get(ticker);
  if (!row || row.change_pct == null) return card;
  const breakdown = parseBreakdown(card.gps_breakdown);
  if (!breakdown) return card;
  try {
    const adjusted = adjustGpsForHorizon(
      breakdown as GpsBreakdown,
      row.change_pct,
      row.confidence ?? undefined,
      horizon,
    );
    return {
      ...card,
      gps_score: adjusted.score,
      gps_breakdown: adjusted.breakdown,
      recommendationLabel: getGpsLabel(adjusted.score),
    } as T;
  } catch {
    return card;
  }
}

/**
 * Two-pass hot_stocks query used when DASHBOARD_TENURE_ROTATION is on.
 *
 * Pass 1 (fresh pool): tickers with consecutive_days ≤ TENURE_MAX_DAYS AND
 *   not in eviction-cooldown, ordered by GPS DESC, capped at TENURE_TARGET_CARDS.
 * Pass 2 (backfill): only runs if Pass 1 returned fewer than TENURE_MIN_CARDS.
 *   Takes remaining hot_stocks by GPS DESC — the "steady quality" names get
 *   in as a safety valve so the section is never empty.
 *
 * Returns the same shape the legacy query does; adds one column
 * (consecutive_days) that the card UI can key a "NEW" badge off of.
 */
const HOT_STOCK_COLUMNS = `
  rs.id, rs.type, rs.ticker, rs.company_name, rs.current_price,
  rs.gps_score, rs.gps_breakdown, rs.classification, rs.analyst_upside_pct,
  rs.revenue_growth_yoy, rs.gross_margin_pct, rs.rd_spend_pct,
  rs.market_cap_m, rs.mention_count, rs.discovery_source,
  rs.trading_signal, rs.trading_signal_score, rs.upcoming_earnings,
  rs.snapshot_date, rs.trailing_pe, rs.price_to_book,
  rs.metric_value, rs.metric_label,
  COALESCE(dt.consecutive_days, 1) AS consecutive_days
`;

async function fetchHotStocksWithRotation(
  stockDate: unknown,
  stockGpsMin: number,
): Promise<any[]> {
  const [freshRows] = await executeRawQuery(
    `SELECT ${HOT_STOCK_COLUMNS}
       FROM recommended_stocks rs
       LEFT JOIN dashboard_tenure dt ON dt.ticker = rs.ticker
      WHERE rs.snapshot_date = ?
        AND rs.type = 'hot_stocks'
        AND rs.gps_score >= ?
        AND (dt.consecutive_days IS NULL OR dt.consecutive_days <= ?)
        AND (dt.evicted_at        IS NULL OR dt.evicted_at        < NOW() - INTERVAL ${TENURE_COOLDOWN_DAYS} DAY)
      ORDER BY rs.gps_score DESC
      LIMIT ?`,
    [stockDate, stockGpsMin, TENURE_MAX_DAYS, TENURE_TARGET_CARDS],
  );
  const fresh = freshRows as any[];

  if (fresh.length >= TENURE_MIN_CARDS) {
    logger.info('Dashboard tenure rotation: fresh pool sufficient', {
      freshCount: fresh.length,
      minCards: TENURE_MIN_CARDS,
      cap: TENURE_TARGET_CARDS,
    });
    return fresh;
  }

  // Backfill from the stale/evicted pool to get to at least TENURE_MIN_CARDS.
  const backfillLimit = TENURE_MIN_CARDS - fresh.length;
  const excludeTickers = fresh.map(r => r.ticker as string);
  const excludeClause = excludeTickers.length
    ? `AND rs.ticker NOT IN (${excludeTickers.map(() => '?').join(',')})`
    : '';
  const [backfillRows] = await executeRawQuery(
    `SELECT ${HOT_STOCK_COLUMNS}
       FROM recommended_stocks rs
       LEFT JOIN dashboard_tenure dt ON dt.ticker = rs.ticker
      WHERE rs.snapshot_date = ?
        AND rs.type = 'hot_stocks'
        AND rs.gps_score >= ?
        ${excludeClause}
      ORDER BY rs.gps_score DESC
      LIMIT ?`,
    [stockDate, stockGpsMin, ...excludeTickers, backfillLimit],
  );
  const combined = [...fresh, ...(backfillRows as any[])];
  logger.info('Dashboard tenure rotation: backfilled from stale pool', {
    freshCount:    fresh.length,
    backfillCount: (backfillRows as any[]).length,
    totalCount:    combined.length,
    minCards:      TENURE_MIN_CARDS,
  });
  return combined;
}

function parseBreakdown(val: unknown): GpsBreakdown | null {
  if (!val) return null;
  if (typeof val === 'string') {
    try { return JSON.parse(val) as GpsBreakdown; } catch { return null; }
  }
  if (typeof val === 'object') return val as GpsBreakdown;
  return null;
}
