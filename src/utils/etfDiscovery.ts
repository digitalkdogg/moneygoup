import { getDbConnection } from './db';
import { yahooFinance, fetchYahooStockSummary, getYahooScreener } from './yahooFinanceHelper';
import etfWatchlist from '../../public/etf_theme_watchlist.json';
import { createLogger } from './logger';
import { fetchETFHoldings, scoreETFHoldings } from './etfHoldings';
import { resolveEtfHoldingAlgorithm } from './etfHoldingPreset';

// --- ETF Constants (moved from config.ts) ---
const ETF_PRICE_FILTER_MAX = 400;
const ETF_VOLUME_FLOOR = 50000;
const ETF_AUM_FLOOR = 50_000_000; // $50M
// ETF qualification threshold (etfGpsThreshold), top-N keep, per-ETF holdings
// cap, holding-surfacing thresholds — all resolved per-run via
// resolveEtfHoldingAlgorithm(process.env.ETF_HOLDING_ALGORITHM).

const ETF_GPS_WEIGHTS = {
  FIFTY_TWO_WEEK_RETURN: 0.255,
  THEMATIC_NEWS_SIGNAL: 0.2125,
  MOMENTUM_3MO: 0.17,
  LIQUIDITY: 0.1275,
  EXPENSE_RATIO: 0.085,
  MACRO_TAILWIND: 0.15,
};

const ETF_GPS_BONUS = {
  HOT_STOCKS_OVERLAP: 8,
  TRENDING_THEME: 5,
  HIGH_MOMENTUM: 4,
  UNDER_THE_RADAR: 3,
  TECH_ADOPTION_VALIDATION: 6, // 0-6 pts
};

const THEME_TO_SUB_SECTORS: { [key: string]: string[] } = {
  "Artificial Intelligence": ["Artificial Intelligence", "Robotics & Automation"],
  "Semiconductors": ["Semiconductors"],
  "Cloud & SaaS": ["Cloud & SaaS", "Cybersecurity"],
  "Cybersecurity": ["Cybersecurity"],
  "Clean Energy & Tech": ["Data Infrastructure"],
  "Broad Technology": ["Artificial Intelligence", "Semiconductors", "Cloud & SaaS", "Cybersecurity", "Data Infrastructure", "Robotics & Automation"],
  "Small/Mid Cap Growth": [],
};

const THEME_MACRO_MAPPING: { [key: string]: { tailwind: string[], validation: string[] } } = {
  "Artificial Intelligence": { 
    tailwind: ['BX.KLT.DINV.WD.GD.ZS', 'TG.VAL.TOTL.GD.ZS'], 
    validation: ['IT.NET.USER.ZS', 'IT.CEL.SETS.P2'] 
  },
  "Semiconductors": { 
    tailwind: ['BX.KLT.DINV.WD.GD.ZS', 'TG.VAL.TOTL.GD.ZS'], 
    validation: ['TX.VAL.ICTG.ZS.UN'] 
  },
  "Cloud & SaaS": { 
    tailwind: ['BX.KLT.DINV.WD.GD.ZS'], 
    validation: ['IT.NET.USER.ZS'] 
  },
  "Cybersecurity": { 
    tailwind: ['BX.KLT.DINV.WD.GD.ZS'], 
    validation: ['IT.NET.USER.ZS'] 
  },
  "Clean Energy & Tech": { 
    tailwind: ['BX.KLT.DINV.WD.GD.ZS', 'TG.VAL.TOTL.GD.ZS'], 
    validation: [] 
  },
  "Broad Technology": { 
    tailwind: ['BX.KLT.DINV.WD.GD.ZS', 'TG.VAL.TOTL.GD.ZS'], 
    validation: ['IT.NET.USER.ZS', 'TX.VAL.ICTG.ZS.UN'] 
  },
  "Small/Mid Cap Growth": { 
    tailwind: ['TG.VAL.TOTL.GD.ZS'], 
    validation: [] 
  },
};
// --- End ETF Constants ---

const logger = createLogger('utils/etfDiscovery');

// Process items in batches of `concurrency` with a `delayMs` pause between
// batches — prevents bursting all requests simultaneously against Yahoo's
// edge throttle.
async function batchedMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  { concurrency = 3, delayMs = 1500 }: { concurrency?: number; delayMs?: number } = {}
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    if (i > 0) await new Promise<void>(r => setTimeout(r, delayMs));
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    results.push(...batchResults);
  }
  return results;
}

// Shared cooldown timestamp (ms). When any ETF fetch hits a 429, this is
// pushed forward by RATE_LIMIT_COOLDOWN_MS so that all subsequent queue
// items pause before firing — letting Yahoo's edge quota window reset.
let rateLimitCooldownUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 45_000;

async function withYahooRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelayMs = 10_000
): Promise<T> {
  const cooldownWait = rateLimitCooldownUntil - Date.now();
  if (cooldownWait > 0) {
    logger.warn(`${label}: rate-limit cooldown active, waiting ${Math.ceil(cooldownWait / 1000)}s`);
    await new Promise<void>(r => setTimeout(r, cooldownWait));
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      const isRateLimit = msg.includes('Too Many Requests') || msg.includes('429') || msg.includes('rate limit');
      if (!isRateLimit || attempt === maxAttempts) throw err;
      lastErr = err;
      // Extend cooldown so the next queued item also waits for quota reset
      rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`${label}: rate-limited (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`);
      await new Promise<void>(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

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
  macro_tailwind_score: number;
  theme_validation_bonus: number;
  discovery_source: string;
  is_leveraged: boolean;
  snapshot_date: string;
  macro_data_asof: string;
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

async function fetchWorldBankTrendData(): Promise<any> {
    try {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
        const res = await fetch(`${baseUrl}/api/worldbank`, {
            headers: { 'x-api-key': internalSecret || '' }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        logger.error('Failed to fetch World Bank trend data for ETF discovery', { error: err });
        return null;
    }
}

export interface PerformETFDiscoveryOptions {
  /** When true, skip scoreETFHoldings entirely. The caller is taking
   *  responsibility for enriching + scoring the holdings (typically because
   *  it wants them in the main discovery enrichment pipeline). */
  skipHoldingsScoring?: boolean;
  /** When provided, holding tickers fetched from qualifying ETFs are added
   *  to this Set so the caller can union them into its enrichment queue. */
  holdingTickersOut?: Set<string>;
  /** Force a fresh Yahoo fetch even if the DB cache is still warm. */
  forceRefresh?: boolean;
}

// How long to reuse the last successful ETF discovery result before going
// back to Yahoo. 48 hours covers weekends and multi-day rate-limit windows:
// any run within 2 trading days uses the last successful snapshot, preventing
// Yahoo quota exhaustion from consecutive deepmoney calls.
const ETF_CACHE_HOURS = 48;

async function loadCachedETFs(topNEtfs: number): Promise<ETFDiscoveryResult[] | null> {
  const pool = await getDbConnection();
  const connection = await pool.getConnection();
  try {
    // Check for a recent successful cycle (qualified > 0 within the TTL window)
    const [rows] = await connection.execute<any[]>(`
      SELECT cycle_date FROM etf_cycle_summary
      WHERE etfs_qualified > 0
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      ORDER BY created_at DESC
      LIMIT 1
    `, [ETF_CACHE_HOURS]);

    if (!rows.length) return null;

    // mysql2 returns DATE columns as JS Date objects when dateStrings is not
    // enabled; convert to YYYY-MM-DD string to avoid timezone rounding issues.
    const rawDate = rows[0].cycle_date;
    const snapshotDate = typeof rawDate === 'string'
      ? rawDate.substring(0, 10)
      : new Date(rawDate).toISOString().substring(0, 10);

    const [etfRows] = await connection.execute<any[]>(`
      SELECT ticker, etf_name, current_price, etf_gps_score, theme,
             aum_m, expense_ratio_pct,
             \`52wk_return_pct\`, \`3mo_return_pct\`, avg_daily_volume,
             momentum_score, news_signal_score, macro_tailwind_score,
             theme_validation_bonus, discovery_source, is_leveraged,
             snapshot_date
      FROM hot_etfs
      WHERE snapshot_date = ?
      ORDER BY etf_gps_score DESC
      LIMIT ?
    `, [snapshotDate, topNEtfs]);

    if (!etfRows.length) return null;

    return etfRows.map((r: any): ETFDiscoveryResult => ({
      ticker:                r.ticker,
      etf_name:              r.etf_name,
      current_price:         parseFloat(r.current_price),
      etf_gps_score:         parseFloat(r.etf_gps_score),
      theme:                 r.theme,
      aum_m:                 parseFloat(r.aum_m),
      expense_ratio_pct:     parseFloat(r.expense_ratio_pct),
      fiftyTwoWk_return_pct: parseFloat(r['52wk_return_pct']),
      threeMo_return_pct:    parseFloat(r['3mo_return_pct']),
      avg_daily_volume:      parseInt(r.avg_daily_volume),
      momentum_score:        parseFloat(r.momentum_score),
      news_signal_score:     parseFloat(r.news_signal_score),
      macro_tailwind_score:  parseFloat(r.macro_tailwind_score),
      theme_validation_bonus: parseFloat(r.theme_validation_bonus),
      discovery_source:      r.discovery_source,
      is_leveraged:          !!r.is_leveraged,
      snapshot_date:         typeof r.snapshot_date === 'string'
                               ? r.snapshot_date
                               : new Date(r.snapshot_date).toISOString().split('T')[0],
      macro_data_asof:       typeof r.snapshot_date === 'string'
                               ? r.snapshot_date
                               : new Date(r.snapshot_date).toISOString().split('T')[0],
    }));
  } catch (err) {
    logger.warn('ETF cache read failed, will fetch fresh', { error: err });
    return null;
  } finally {
    connection.release();
  }
}

export async function performETFDiscovery(
  hotStocks: any[],
  trendingSubSectors: string[],
  trendingTickers: string[] = [],
  options: PerformETFDiscoveryOptions = {}
): Promise<ETFDiscoveryResult[]> {
  const startTime = Date.now();
  const snapshotDate = new Date().toISOString().split('T')[0];
  const hotStockTickers = new Set(hotStocks.map(s => s.ticker));
  const newsTickerSet = new Set(trendingTickers);

  // Resolve once per run; all downstream gates (qualification threshold,
  // top-N keep, per-ETF holdings cap, holding-surfacing thresholds) come
  // from this preset. scoreETFHoldings receives it via sharedContext.
  const etfHoldingAlgorithm = resolveEtfHoldingAlgorithm(process.env.ETF_HOLDING_ALGORITHM);

  logger.info('Starting ETF discovery', {
    hotStocksCount: hotStocks.length,
    newsTickersCount: trendingTickers.length,
    trendingSubSectors,
    etfHoldingAlgorithmLevel: etfHoldingAlgorithm.level,
  });

  // --- Staleness cache: reuse last successful run if it's recent enough ---
  // Skips 27+ Yahoo quoteSummary calls when Yahoo's quota is already
  // exhausted by the preceding stock-enrichment pipeline.
  if (!options.forceRefresh) {
    const cached = await loadCachedETFs(etfHoldingAlgorithm.topNEtfs);
    if (cached) {
      logger.info('ETF discovery: returning cached results (last successful run within 48h)', {
        count: cached.length,
      });
      // Still populate holdingTickersOut so the caller's enrichment queue gets
      // the holdings tickers (using the cached qualifying ETFs, not all 27).
      if (options.holdingTickersOut && cached.length > 0) {
        const maxTickers = etfHoldingAlgorithm.maxTickers;
        await batchedMap(
          cached,
          async etf => {
            const holdings = await fetchETFHoldings(etf.ticker, maxTickers);
            for (const h of holdings) {
              if (h.ticker) options.holdingTickersOut!.add(h.ticker.toUpperCase());
            }
          },
          { concurrency: 2, delayMs: 1000 }
        );
      }
      return cached;
    }
  }

  // Fetch World Bank Macro Context
  const wbData = await fetchWorldBankTrendData();
  const themeTrends = wbData?.etf_factors?.theme_trends || {};
  const macroAsOf = wbData?.asOf;

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

  // Stock enrichment (enrichTickers) runs before this function and makes 3+
  // Yahoo calls per ticker. By the time we reach here the per-session quota is
  // often exhausted. Pause 75s so Yahoo's rate-limit window can reset before
  // we start the ETF candidate loop.
  const PRE_ETF_PAUSE_MS = 75_000;
  logger.info(`ETF discovery: pausing ${PRE_ETF_PAUSE_MS / 1000}s for Yahoo quota reset before candidate fetch`);
  await new Promise<void>(r => setTimeout(r, PRE_ETF_PAUSE_MS));

  const errors: string[] = [];

  // Serialize candidates (concurrency: 1) with a 3.5s gap to stay well under
  // Yahoo's edge rate limit, which gets saturated by the preceding stock
  // enrichment pipeline. The retry wrapper handles transient 429s.
  const results = await batchedMap(candidates, async (candidate) => {
    try {
      const summary: any = await withYahooRetry(
        () => Promise.race([
          yahooFinance.quoteSummary(candidate.ticker, {
            modules: ["price", "summaryDetail", "defaultKeyStatistics", "topHoldings", "fundProfile", "fundPerformance"]
          }, { validateResult: false }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
        ]).catch(err => {
          if (err.name === 'FailedYahooValidationError' && err.result) {
            return err.result;
          }
          throw err;
        }),
        candidate.ticker
      );

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
      // 1. 52-Week Price Return (25.5%)
      score += Math.min(Math.max(fiftyTwoWkReturn / 0.3, 0), 1) * 100 * ETF_GPS_WEIGHTS.FIFTY_TWO_WEEK_RETURN;
      
      // 2. Thematic News Signal Alignment (21.25%)
      const newsSignalScore = Math.min(newsOverlap.length / 2, 1) * 100;
      score += (newsSignalScore / 100) * 100 * ETF_GPS_WEIGHTS.THEMATIC_NEWS_SIGNAL;
      
      // 3. Momentum Score (3-month return) (17.0%)
      score += Math.min(Math.max(threeMoReturn / 0.15, 0), 1) * 100 * ETF_GPS_WEIGHTS.MOMENTUM_3MO;
      
      // 4. Volume / Liquidity Score (12.75%)
      score += Math.min(volume / 1000000, 1) * 100 * ETF_GPS_WEIGHTS.LIQUIDITY;
      
      // 5. Expense Ratio Efficiency (8.5%)
      const expenseScore = Math.max(0, Math.min(1, (1.5 - (expRatio * 100)) / (1.5 - 0.05))) * 100;
      score += (expenseScore / 100) * 100 * ETF_GPS_WEIGHTS.EXPENSE_RATIO;

      // 6. Macro Tailwind Score (15.0%)
      const macroMapping = THEME_MACRO_MAPPING[candidate.theme] || { tailwind: [], validation: [] };
      let tailwindScore = 0;
      if (macroMapping.tailwind.length > 0) {
          let signalSum = 0;
          macroMapping.tailwind.forEach(code => {
              const trend = themeTrends[candidate.theme]?.[code];
              if (trend) {
                  if (trend.signal === 'bullish') signalSum += 100;
                  else if (trend.signal === 'neutral') signalSum += 50;
              } else {
                  signalSum += 50; // Neutral fallback
              }
          });
          tailwindScore = signalSum / macroMapping.tailwind.length;
      } else {
          tailwindScore = 50; // Neutral default
      }
      score += (tailwindScore / 100) * 100 * ETF_GPS_WEIGHTS.MACRO_TAILWIND;

      // --- Bonuses ---
      if (hotStocksOverlap.length >= 3) score += ETF_GPS_BONUS.HOT_STOCKS_OVERLAP;
      
      const mappedSubSectors = THEME_TO_SUB_SECTORS[candidate.theme] || [];
      if (mappedSubSectors.some(ms => trendingSubSectors.includes(ms))) {
        score += ETF_GPS_BONUS.TRENDING_THEME;
      }
      
      if (fiftyTwoWkReturn >= 0.25) score += ETF_GPS_BONUS.HIGH_MOMENTUM;
      if (aum < 500e6) score += ETF_GPS_BONUS.UNDER_THE_RADAR;

      // Tech Adoption Validation Bonus
      let themeValidationBonus = 0;
      if (macroMapping.validation.length > 0) {
          let valSum = 0;
          macroMapping.validation.forEach(code => {
            const trend = themeTrends[candidate.theme]?.[code];
            if (trend && trend.signal === 'bullish') valSum += 3;
            else if (trend && trend.signal === 'neutral') valSum += 1;
          });
          themeValidationBonus = Math.min(valSum, ETF_GPS_BONUS.TECH_ADOPTION_VALIDATION);
          score += themeValidationBonus;
      }

      const finalScore = Math.min(score, 100);

      if (finalScore >= etfHoldingAlgorithm.etfGpsThreshold) {
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
          macro_tailwind_score: parseFloat(tailwindScore.toFixed(1)),
          theme_validation_bonus: themeValidationBonus,
          discovery_source: candidate.source + (newsOverlap.length > 0 ? '+news_signal' : '') + (tailwindScore > 70 ? '+macro_confirmed' : ''),
          is_leveraged: isLeveraged,
          snapshot_date: snapshotDate,
          macro_data_asof: macroAsOf
        };
      }
    } catch (err) {
      logger.error(`Error enriching ETF ${candidate.ticker}`, { error: err });
      errors.push(`${candidate.ticker}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }, { concurrency: 1, delayMs: 3500 });

  const qualifyingETFs = results.filter((r): r is ETFDiscoveryResult => r !== null);

  logger.info('ETF discovery complete', { 
    qualifyingCount: qualifyingETFs.length,
    durationMs: Date.now() - startTime 
  });

  const finalResults = qualifyingETFs
    .sort((a, b) => b.etf_gps_score - a.etf_gps_score)
    .slice(0, etfHoldingAlgorithm.topNEtfs);

  // --- Phase 3: Score top holdings for each qualifying ETF ------------------
  try {
    // maxTickers caps (a) the per-ETF fetch from Yahoo (here) and (b) the
    // post-dedup global scoring cap inside scoreETFHoldings. Both derive
    // from the same preset, so they always agree.
    const maxTickers = etfHoldingAlgorithm.maxTickers;

    // Fetch holdings in batches of 2 to avoid rate-limiting on ETF holdings lookups
    const holdingsByETF = await batchedMap(
      finalResults,
      async etf => ({
        etfTicker: etf.ticker,
        holdings: await fetchETFHoldings(etf.ticker, maxTickers),
      }),
      { concurrency: 2, delayMs: 1000 }
    );

    // Aggregate all holdings into one list for global deduplication scoring
    const allHoldings = holdingsByETF.flatMap(e => e.holdings);

    // Surface ticker symbols to the caller's enrichment queue, regardless of
    // whether we also do the scoring pass below.
    if (options.holdingTickersOut) {
      for (const h of allHoldings) {
        if (h.ticker) options.holdingTickersOut.add(h.ticker.toUpperCase());
      }
    }

    if (options.skipHoldingsScoring) {
      logger.info('ETF holdings scoring skipped (caller will enrich + score via main pipeline)', {
        totalHoldings: allHoldings.length,
      });
    } else if (allHoldings.length > 0) {
      const scored = await scoreETFHoldings(allHoldings, { wbData, etfHoldingPreset: etfHoldingAlgorithm });

      const totalSurfaced = scored.filter(h => h.surfaced).length;
      logger.info(`ETF holdings scoring complete`, { totalScoredHoldings: scored.length, totalSurfaced });
    }
  } catch (holdingsErr) {
    logger.error('ETF holdings scoring failed — continuing without holdings data', { error: holdingsErr });
  }

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
          \`avg_daily_volume\`, \`momentum_score\`, \`news_signal_score\`, \`macro_tailwind_score\`, \`theme_validation_bonus\`,
          \`discovery_source\`, \`is_leveraged\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          \`macro_tailwind_score\` = VALUES(\`macro_tailwind_score\`),
          \`theme_validation_bonus\` = VALUES(\`theme_validation_bonus\`),
          \`discovery_source\` = VALUES(\`discovery_source\`),
          \`is_leveraged\` = VALUES(\`is_leveraged\`)
      `, [
        etf.ticker, etf.etf_name, etf.snapshot_date, etf.current_price, etf.etf_gps_score,
        etf.theme, etf.aum_m, etf.expense_ratio_pct, etf.fiftyTwoWk_return_pct, etf.threeMo_return_pct,
        etf.avg_daily_volume, etf.momentum_score, etf.news_signal_score, etf.macro_tailwind_score, etf.theme_validation_bonus,
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
