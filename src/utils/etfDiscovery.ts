import { getDbConnection } from './db';
import { yahooFinance, fetchYahooStockSummary, getYahooScreener } from './yahooFinanceHelper';
import etfWatchlist from '../../public/etf_theme_watchlist.json';
import { createLogger } from './logger';

import {
  ETF_PRICE_FILTER_MAX,
  ETF_VOLUME_FLOOR,
  ETF_AUM_FLOOR,
  ETF_GPS_WEIGHTS,
  ETF_GPS_BONUS,
  ETF_GPS_THRESHOLD,
  THEME_TO_SUB_SECTORS
} from '../app/api/deepmoney/config';

const logger = createLogger('utils/etfDiscovery');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ETFDiscoveryResult {
  ticker: string;
  etf_name: string;
  current_price: number;
  etf_gps_score: number;
  theme: string;
  aum_m: number;
  expense_ratio_pct: number;
  fiftyTwoWk_return_pct: number;
  threeMo_return_pct: number;
  avg_daily_volume: number;
  momentum_score: number;
  news_signal_score: number;
  discovery_source: string;
  is_leveraged: boolean;
  snapshot_date: string;
}

export interface ETFCycleSummary {
  cycle_date: string;
  etfs_evaluated: number;
  etfs_qualified: number;
  etfs_persisted: number;
  avg_etf_gps_score: number;
  top_theme: string;
  cycle_duration_ms: number;
  errors: string;
}

// ---------------------------------------------------------------------------
// ETF Module Implementation
// ---------------------------------------------------------------------------

export async function performETFDiscovery(
  hotStocks: any[],
  trendingSubSectors: string[],
  trendingTickers: string[] = []
): Promise<ETFDiscoveryResult[]> {
  const startTime = Date.now();
  const snapshotDate = new Date().toISOString().split('T')[0];
  const hotStockTickers = new Set(hotStocks.map(s => s.ticker));
  const newsTickerSet = new Set(trendingTickers);
  
  logger.info('Starting ETF discovery', { 
    hotStocksCount: hotStocks.length, 
    newsTickersCount: trendingTickers.length,
    trendingSubSectors 
  });

  const evaluatedTickers = new Set<string>();
  const candidates: { ticker: string; theme: string; source: string }[] = [];

  // Strategy C: Thematic Watchlist
  for (const item of etfWatchlist) {
    candidates.push({ ...item, source: 'theme_watchlist' });
    evaluatedTickers.add(item.ticker);
  }

  // Strategy B: ETF Dynamic Screener
  try {
    const screeners = ['most_actives', 'day_gainers'];
    const screenerResults = await Promise.all(screeners.map(s => getYahooScreener(s)));
    
    for (const res of screenerResults) {
      for (const quote of res.quotes) {
        if (quote.symbol && !evaluatedTickers.has(quote.symbol) && quote.quoteType === 'ETF') {
          candidates.push({ ticker: quote.symbol, theme: 'General', source: 'etf_screener' });
          evaluatedTickers.add(quote.symbol);
        }
      }
    }
  } catch (err) {
    logger.error('Error in ETF screener strategy', { error: err });
  }

  const evaluatedTickersCount = evaluatedTickers.size;
  logger.info('ETF candidates identified', { 
    totalCandidates: candidates.length,
    evaluatedTickersCount: evaluatedTickersCount
  });

  const errors: string[] = [];

  // Process all candidates in parallel with individual timeouts and error handling
  const results = await Promise.all(candidates.map(async (candidate) => {
    try {
      const summary = await Promise.race([
        yahooFinance.quoteSummary(candidate.ticker, {
          modules: ["price", "summaryDetail", "defaultKeyStatistics", "topHoldings", "fundProfile", "fundPerformance"]
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]).catch(err => {
        if (err.name === 'FailedYahooValidationError' && err.result) {
          return err.result;
        }
        throw err;
      });

      const price = summary.price?.regularMarketPrice;
      if (!price || price >= ETF_PRICE_FILTER_MAX) return null;

      const volume = summary.summaryDetail?.averageDailyVolume10Day || summary.summaryDetail?.averageVolume || 0;
      if (volume < ETF_VOLUME_FLOOR) return null;

      const aum = summary.summaryDetail?.totalAssets || 0;
      if (aum < ETF_AUM_FLOOR) return null;

      const isLeveraged = summary.fundProfile?.isLeveraged ?? false;
      const includeLeveraged = process.env.INCLUDE_LEVERAGED_ETFS === 'true';
      if (isLeveraged && !includeLeveraged) return null;

      // Extract Performance & Expense Data
      const profile = summary.fundProfile;
      const performance = summary.fundPerformance;
      const stats = summary.defaultKeyStatistics;
      const detail = summary.summaryDetail;

      const expRatio = profile?.feesExpensesInvestment?.annualReportExpenseRatio 
                     || detail?.expenseRatio 
                     || stats?.netExpenseRatio
                     || 0;

      const fiftyTwoWkReturn = performance?.trailingReturns?.oneYear
                             || stats?.fiftyTwoWeekChange
                             || detail?.fiftyTwoWeekLowChangePercent
                             || 0;

      const threeMoReturn = performance?.trailingReturns?.threeMonth
                          || stats?.threeMonthReturn
                          || fiftyTwoWkReturn / 4;

      // Strategy A: News Signal Alignment (Holdings overlap)
      const holdings = summary.topHoldings?.holdings || [];
      const holdingsTickers = holdings.map((h: any) => h.symbol).filter(Boolean) as string[];
      
      const newsOverlap = holdingsTickers.filter(t => newsTickerSet.has(t));
      const hotStocksOverlap = holdingsTickers.filter(t => hotStockTickers.has(t));
      
      let score = 0;
      // 52-Week Price Return (30%)
      score += Math.min(Math.max(fiftyTwoWkReturn / 0.3, 0), 1) * 100 * ETF_GPS_WEIGHTS.FIFTY_TWO_WEEK_RETURN;
      
      // Thematic News Signal Alignment (25%)
      const newsSignalScore = Math.min(newsOverlap.length / 2, 1) * 100;
      score += (newsSignalScore / 100) * 100 * ETF_GPS_WEIGHTS.THEMATIC_NEWS_SIGNAL;
      
      // Momentum Score (3-month return) (20%)
      score += Math.min(Math.max(threeMoReturn / 0.15, 0), 1) * 100 * ETF_GPS_WEIGHTS.MOMENTUM_3MO;
      
      // Volume / Liquidity Score (15%)
      score += Math.min(volume / 1000000, 1) * 100 * ETF_GPS_WEIGHTS.LIQUIDITY;
      
      // Expense Ratio Efficiency (10%)
      const expenseScore = Math.max(0, Math.min(1, (1.5 - (expRatio * 100)) / (1.5 - 0.05))) * 100;
      score += (expenseScore / 100) * 100 * ETF_GPS_WEIGHTS.EXPENSE_RATIO;

      // Bonuses
      if (hotStocksOverlap.length >= 3) score += ETF_GPS_BONUS.HOT_STOCKS_OVERLAP;
      
      const mappedSubSectors = THEME_TO_SUB_SECTORS[candidate.theme] || [];
      if (mappedSubSectors.some(ms => trendingSubSectors.includes(ms))) {
        score += ETF_GPS_BONUS.TRENDING_THEME;
      }
      
      if (fiftyTwoWkReturn >= 0.25) score += ETF_GPS_BONUS.HIGH_MOMENTUM;
      if (aum < 500e6) score += ETF_GPS_BONUS.UNDER_THE_RADAR;

      const finalScore = Math.min(score, 100);

      if (finalScore >= ETF_GPS_THRESHOLD) {
        return {
          ticker: candidate.ticker,
          etf_name: summary.price?.longName || summary.price?.shortName || candidate.ticker,
          current_price: price,
          etf_gps_score: parseFloat(finalScore.toFixed(1)),
          theme: candidate.theme,
          aum_m: parseFloat((aum / 1e6).toFixed(2)),
          expense_ratio_pct: parseFloat((expRatio * 100).toFixed(3)),
          fiftyTwoWk_return_pct: parseFloat((fiftyTwoWkReturn * 100).toFixed(2)),
          threeMo_return_pct: parseFloat((threeMoReturn * 100).toFixed(2)),
          avg_daily_volume: volume,
          momentum_score: parseFloat(((threeMoReturn * 100)).toFixed(1)),
          news_signal_score: parseFloat(newsSignalScore.toFixed(1)),
          discovery_source: candidate.source + (newsOverlap.length > 0 ? '+news_signal' : ''),
          is_leveraged: isLeveraged,
          snapshot_date: snapshotDate
        };
      }
    } catch (err) {
      logger.error(`Error enriching ETF ${candidate.ticker}`, { error: err });
      errors.push(`${candidate.ticker}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }));

  const qualifyingETFs: ETFDiscoveryResult[] = results.filter((r): r is ETFDiscoveryResult => r !== null);

  logger.info('ETF discovery complete', { 
    qualifyingCount: qualifyingETFs.length,
    durationMs: Date.now() - startTime 
  });

  const finalResults = qualifyingETFs.sort((a, b) => b.etf_gps_score - a.etf_gps_score).slice(0, 10);

  const duration = Date.now() - startTime;
  await persistETFs(finalResults, {
    cycle_date: snapshotDate,
    etfs_evaluated: evaluatedTickersCount,
    etfs_qualified: qualifyingETFs.length,
    etfs_persisted: finalResults.length,
    avg_etf_gps_score: finalResults.length > 0 
      ? parseFloat((finalResults.reduce((acc, curr) => acc + curr.etf_gps_score, 0) / finalResults.length).toFixed(1))
      : 0,
    top_theme: getTopTheme(finalResults),
    cycle_duration_ms: duration,
    errors: errors.join('; ').slice(0, 1000)
  });

  return finalResults;
}

function getTopTheme(etfs: ETFDiscoveryResult[]): string {
  if (etfs.length === 0) return 'None';
  const themes: { [theme: string]: number } = {};
  etfs.forEach(e => {
    themes[e.theme] = (themes[e.theme] || 0) + e.etf_gps_score;
  });
  return Object.entries(themes).sort((a, b) => b[1] - a[1])[0][0];
}

async function persistETFs(etfs: ETFDiscoveryResult[], summary: ETFCycleSummary) {
  const pool = await getDbConnection();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const etf of etfs) {
      await connection.execute(`
        INSERT INTO hot_etfs (
          \`ticker\`, \`etf_name\`, \`snapshot_date\`, \`current_price\`, \`etf_gps_score\`,
          \`theme\`, \`aum_m\`, \`expense_ratio_pct\`, \`52wk_return_pct\`, \`3mo_return_pct\`,
          \`avg_daily_volume\`, \`momentum_score\`, \`news_signal_score\`,
          \`discovery_source\`, \`is_leveraged\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          \`etf_name\` = VALUES(\`etf_name\`),
          \`current_price\` = VALUES(\`current_price\`),
          \`etf_gps_score\` = VALUES(\`etf_gps_score\`),
          \`theme\` = VALUES(\`theme\`),
          \`aum_m\` = VALUES(\`aum_m\`),
          \`expense_ratio_pct\` = VALUES(\`expense_ratio_pct\`),
          \`52wk_return_pct\` = VALUES(\`52wk_return_pct\`),
          \`3mo_return_pct\` = VALUES(\`3mo_return_pct\`),
          \`avg_daily_volume\` = VALUES(\`avg_daily_volume\`),
          \`momentum_score\` = VALUES(\`momentum_score\`),
          \`news_signal_score\` = VALUES(\`news_signal_score\`),
          \`discovery_source\` = VALUES(\`discovery_source\`),
          \`is_leveraged\` = VALUES(\`is_leveraged\`)
      `, [
        etf.ticker, etf.etf_name, etf.snapshot_date, etf.current_price, etf.etf_gps_score,
        etf.theme, etf.aum_m, etf.expense_ratio_pct, etf.fiftyTwoWk_return_pct, etf.threeMo_return_pct,
        etf.avg_daily_volume, etf.momentum_score, etf.news_signal_score,
        etf.discovery_source, etf.is_leveraged ? 1 : 0
      ]);
    }

    await connection.execute(`
      INSERT INTO etf_cycle_summary (
        cycle_date, etfs_evaluated, etfs_qualified, etfs_persisted,
        avg_etf_gps_score, top_theme, cycle_duration_ms, errors
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      summary.cycle_date, summary.etfs_evaluated, summary.etfs_qualified, summary.etfs_persisted,
      summary.avg_etf_gps_score, summary.top_theme, summary.cycle_duration_ms, summary.errors
    ]);

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    console.error('Failed to persist ETFs:', err);
  } finally {
    connection.release();
  }
}
