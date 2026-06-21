import { yahooFinance } from './yahooFinanceHelper';
import { runPredictionInternal } from './stockDataHelper';
import { calculateGpsScore } from './gps';
import { executeRawQuery } from './databaseHelper';
import { createLogger } from './logger';
import companyTickersRaw from '../../public/company_tickers.json';
import { resolveEtfHoldingAlgorithm, type EtfHoldingPreset } from './etfHoldingPreset';

const logger = createLogger('utils/etfHoldings');

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

// Build ETF ticker set once at module load — used for ETF-of-ETF filtering.
const ETF_TICKER_SET = new Set<string>(
  (companyTickersRaw as Array<{ ticker: string; is_etf: boolean | null }>)
    .filter(e => e.is_etf === true)
    .map(e => e.ticker.toUpperCase())
);

function getEnv(key: string, defaultVal: string): string {
  return process.env[key] ?? defaultVal;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ETFHolding {
  ticker: string;
  companyName: string;
  holdingPercent: number;  // decimal fraction, e.g. 0.07 = 7%
  parentETFTicker: string;
}

export interface ScoredETFHolding extends ETFHolding {
  gps_score: number;
  gps_breakdown: object;
  predicted_change_pct: number;
  confidence_score: number;
  predicted_price_1m: number;
  bearish_signal: boolean;
  surfaced: boolean;        // Phase 3 sets this to true when thresholds are met
  score_source: 'fresh' | 'cached';
  beta: number | null;      // needed for Phase 3 volatility gate
}

// ---------------------------------------------------------------------------
// fetchETFHoldings
// ---------------------------------------------------------------------------

export async function fetchETFHoldings(ticker: string, topN: number): Promise<ETFHolding[]> {
  try {
    const summary = await yahooFinance.quoteSummary(ticker.toUpperCase(), {
      modules: ['topHoldings'] as any,
    });

    const holdings: any[] = (summary as any).topHoldings?.holdings;
    if (!Array.isArray(holdings) || holdings.length === 0) {
      return [];
    }

    return holdings
      .filter(h => typeof h.symbol === 'string' && h.symbol.trim() !== '')
      .filter(h => !ETF_TICKER_SET.has(h.symbol.trim().toUpperCase()))
      .map(h => ({
        ticker:          h.symbol.trim().toUpperCase(),
        companyName:     h.holdingName || h.symbol,
        holdingPercent:  h.holdingPercent ?? 0,
        parentETFTicker: ticker.toUpperCase(),
      }))
      .sort((a, b) => b.holdingPercent - a.holdingPercent)
      .slice(0, topN);
  } catch (err) {
    logger.error('fetchETFHoldings failed', {
      ticker,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CachedScore {
  gps_score: number;
  gps_breakdown: object;
}

async function checkCache(ticker: string, stalenessHours: number): Promise<CachedScore | null> {
  try {
    const [rows] = await executeRawQuery(
      `SELECT sgs.gps_score, sgs.gps_breakdown
       FROM stock_gps_scores sgs
       JOIN stocks s ON s.id = sgs.stock_id
       WHERE s.symbol = ?
         AND TIMESTAMPDIFF(HOUR, sgs.as_of, NOW()) <= ?`,
      [ticker, stalenessHours]
    );
    const row = (rows as any[])[0];
    if (!row?.gps_score) return null;

    let breakdown: object = {};
    if (row.gps_breakdown) {
      try {
        breakdown = typeof row.gps_breakdown === 'string'
          ? JSON.parse(row.gps_breakdown)
          : row.gps_breakdown;
      } catch {}
    }
    return { gps_score: parseFloat(row.gps_score), gps_breakdown: breakdown };
  } catch {
    return null;
  }
}

interface FreshScore {
  gps_score: number;
  gps_breakdown: object;
  predicted_change_pct: number;
  confidence_score: number;
  predicted_price_1m: number;
  bearish_signal: boolean;
  beta: number | null;
}

async function scoreFresh(ticker: string, wbData?: any): Promise<FreshScore | null> {
  const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterday    = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Fetch historical OHLCV and fundamentals in parallel
  const [chartResult, summary] = await Promise.all([
    yahooFinance.chart(ticker, { period1: fiveYearsAgo, period2: yesterday, interval: '1d' })
      .catch(() => ({ quotes: [] as any[] })),
    yahooFinance.quoteSummary(ticker, {
      modules: ['price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile'] as any,
    }).catch(() => ({})),
  ]);

  const quotes = (chartResult as any).quotes ?? [];
  if (quotes.length < 365) {
    throw new Error(`Insufficient history: ${quotes.length} rows`);
  }

  const historicalData = quotes.map((r: any) => ({
    date:   new Date(r.date).toISOString().slice(0, 10),
    open:   r.open   ?? 0,
    high:   r.high   ?? 0,
    low:    r.low    ?? 0,
    close:  r.adjClose ?? r.close ?? 0,
    volume: r.volume ?? 0,
  }));

  const price    = (summary as any).price                  ?? {};
  const detail   = (summary as any).summaryDetail           ?? {};
  const finData  = (summary as any).financialData           ?? {};
  const keyStats = (summary as any).defaultKeyStatistics    ?? {};

  const currentPrice     = price.regularMarketPrice ?? null;
  const analystTarget    = finData.targetMeanPrice  ?? null;
  const analystUpside    = analystTarget && currentPrice
    ? (analystTarget - currentPrice) / currentPrice
    : 0;
  const fiftyTwoWeekChange = keyStats.fiftyTwoWeekChange ?? 0;
  const beta               = keyStats.beta ?? detail.beta ?? null;
  const recommendationKey  = finData.recommendationKey ?? undefined;
  const revenueGrowth      = finData.revenueGrowth      ?? 0;
  const earningsGrowth     = finData.earningsGrowth     ?? 0;

  const payload = {
    ticker,
    historicalData,
    stockMetrics: {
      regularMarketPrice: currentPrice,
      peRatio:            detail.trailingPE || price.trailingPE,
      pbRatio:            keyStats.priceToBook || detail.priceToBook,
      marketCap:          price.marketCap || detail.marketCap,
      revenueGrowth,
      earningsGrowth,
      sector:             (summary as any).assetProfile?.sector ?? 'Unknown',
      analystUpside,
      fiftyTwoWeekChange,
      recommendationKey,
    },
    macroData: {
      worldBank: wbData ? { indicators: wbData.macro?.indicators, asOf: wbData.asOf } : null,
    },
    optionsData:  { available: false },
    dataQuality:  { historyDays: historicalData.length },
  };

  const predResult = await runPredictionInternal(ticker, payload, '1_month');

  const predicted_change_pct = predResult.predicted_change_pct ?? 0;
  const confidence_score     = predResult.confidence_score     ?? 0;
  const predicted_price_1m   = predResult.predicted_price_1m   ?? 0;

  const gpsResult = calculateGpsScore(
    {
      analystUpside,
      revenueGrowthPct:  revenueGrowth,
      earningsGrowthPct: earningsGrowth,
      priceChange52w:    fiftyTwoWeekChange,
      technicalScore:    0,  // not available at this pipeline stage; neutral = 10 pts
      recommendationKey,
    },
    {
      predictedChangePct1m: predicted_change_pct,
      confidenceScore:      confidence_score,
    }
  );

  return {
    gps_score:           gpsResult.score,
    gps_breakdown:       gpsResult.breakdown,
    predicted_change_pct,
    confidence_score,
    predicted_price_1m,
    bearish_signal:      gpsResult.bearishSignal,
    beta,
  };
}

// ---------------------------------------------------------------------------
// scoreETFHoldings
// ---------------------------------------------------------------------------

export async function scoreETFHoldings(
  holdings: ETFHolding[],
  sharedContext?: { wbData?: any; marketIndices?: any; etfHoldingPreset?: EtfHoldingPreset }
): Promise<ScoredETFHolding[]> {
  const stalenessHours = parseInt(getEnv('ETF_HOLDING_STALENESS_HOURS', '6'), 10);
  // Preset resolves once at the entry point of the run (etfDiscovery.ts or
  // a direct caller). If a caller invokes scoreETFHoldings without passing
  // it, we fall back to reading ETF_HOLDING_ALGORITHM ourselves.
  const preset = sharedContext?.etfHoldingPreset
    ?? resolveEtfHoldingAlgorithm(process.env.ETF_HOLDING_ALGORITHM);
  const maxTickers = preset.maxTickers;
  const BATCH_SIZE = 5;

  // --- Deduplication: one score per unique ticker, highest-weight first -----
  const byTicker = new Map<string, ETFHolding[]>();
  for (const h of holdings) {
    const t = h.ticker.toUpperCase();
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t)!.push(h);
  }

  // Sort unique tickers by max holdingPercent among their entries, then cap
  const uniqueTickers = [...byTicker.entries()]
    .sort((a, b) => Math.max(...b[1].map(h => h.holdingPercent)) - Math.max(...a[1].map(h => h.holdingPercent)))
    .slice(0, maxTickers)
    .map(([t]) => t);

  if (uniqueTickers.length === 0) return [];

  // scoreMap: ticker → scored result
  const scoreMap = new Map<string, Omit<ScoredETFHolding, keyof ETFHolding>>();

  // --- Process in batches of BATCH_SIZE --------------------------------------
  for (let i = 0; i < uniqueTickers.length; i += BATCH_SIZE) {
    const batch = uniqueTickers.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async ticker => {
      // 1. Cache check
      const cached = await checkCache(ticker, stalenessHours);
      if (cached) {
        scoreMap.set(ticker, {
          gps_score:           cached.gps_score,
          gps_breakdown:       cached.gps_breakdown,
          predicted_change_pct: 0,
          confidence_score:    0,
          predicted_price_1m:  0,
          bearish_signal:      false,
          surfaced:            false,
          score_source:        'cached',
          beta:                null,
        });
        logger.info(`scoreETFHoldings: cache hit for ${ticker}`);
        return;
      }

      // 2. Fresh score
      try {
        const fresh = await scoreFresh(ticker, sharedContext?.wbData);
        if (!fresh) return;
        scoreMap.set(ticker, {
          ...fresh,
          surfaced:     false,
          score_source: 'fresh',
        });
        logger.info(`scoreETFHoldings: scored ${ticker} → GPS ${fresh.gps_score}`);
      } catch (err) {
        logger.warn(`scoreETFHoldings: skipping ${ticker}`, {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }));
  }

  // --- Fan out: attach score to every holding that references the ticker -----
  const results: ScoredETFHolding[] = [];
  for (const [ticker, holdingList] of byTicker) {
    const scored = scoreMap.get(ticker.toUpperCase());
    if (!scored) continue;  // prediction failed — holding silently dropped
    for (const h of holdingList) {
      results.push({ ...h, ...scored });
    }
  }

  // --- Surfacing: mark holdings that clear all quality thresholds ------------
  // gpsSurfaceValue + minPredChangePct come from the preset (ETF_HOLDING_ALGORITHM);
  // maxBeta is kept as an independent env knob (not part of the preset).
  const gpsSurfaceValue  = preset.gpsSurfaceValue;
  const minPredChangePct = preset.minPredChangePct;
  const maxBeta          = parseFloat(getEnv('ETF_HOLDING_MAX_BETA', '2.0'));

  for (const r of results) {
    if (
      r.gps_score >= gpsSurfaceValue &&
      r.predicted_change_pct >= minPredChangePct &&
      !r.bearish_signal &&
      (r.beta === null || r.beta <= maxBeta)
    ) {
      r.surfaced = true;
    }
  }

  const surfacedCount = results.filter(r => r.surfaced).length;
  logger.info(`scoreETFHoldings: ${results.length} holdings scored across ${uniqueTickers.length} unique tickers, ${surfacedCount} surfaced`);
  return results;
}
