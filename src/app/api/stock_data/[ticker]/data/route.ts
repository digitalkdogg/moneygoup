// GET /api/stock_data/[ticker]/data
// Fetches the enriched 5-year data payload used by the LSTM prediction pipeline.
// All data is gathered here (Next.js side) so scripts/predict_weighted_analysis.py
// receives a pre-assembled payload and never makes outbound network calls.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { unauthorizedResponse, validationErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';
import { macroCache } from '@/utils/cache';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators';
import { executeRawQuery } from '@/utils/databaseHelper';
import { spawn } from 'child_process';
import { getPythonExecutable } from '@/utils/pythonPath';

const logger = createLogger('api/stock/[ticker]/data');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------------------------------------------------------------------------
// Server-side cache — 15-minute TTL, hard cap of 500 entries
// ---------------------------------------------------------------------------
const DATA_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DATA_CACHE_MAX = 500;
export const dataCache = new Map<string, { data: unknown; fetchedAt: number }>();

function getCached(ticker: string): unknown | null {
  const entry = dataCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > DATA_CACHE_TTL_MS) {
    dataCache.delete(ticker);
    return null;
  }
  return entry.data;
}

function setCache(ticker: string, data: unknown): void {
  const now = Date.now();
  // Lazy eviction of stale entries
  for (const [k, v] of dataCache.entries()) {
    if (now - v.fetchedAt > DATA_CACHE_TTL_MS) dataCache.delete(k);
  }
  if (dataCache.size >= DATA_CACHE_MAX) {
    logger.warn('dataCache exceeded max entries — clearing', { size: dataCache.size });
    dataCache.clear();
  }
  dataCache.set(ticker, { data, fetchedAt: now });
}

// ---------------------------------------------------------------------------
// Sector → ETF mapping
// ---------------------------------------------------------------------------
const SECTOR_ETF: Record<string, string> = {
  Technology: 'XLK',
  Healthcare: 'XLV',
  Financials: 'XLF',
  'Financial Services': 'XLF',
  'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP',
  Industrials: 'XLI',
  Energy: 'XLE',
  Utilities: 'XLU',
  'Real Estate': 'XLRE',
  'Basic Materials': 'XLB',
  Materials: 'XLB',
  'Communication Services': 'XLC',
};

// ---------------------------------------------------------------------------
// Sector median imputation table
// ---------------------------------------------------------------------------
const SECTOR_MEDIANS: Record<string, Record<string, number>> = {
  Technology:             { peRatio: 28.0, pbRatio: 6.0,  profitMargins: 0.20, revenueGrowth: 0.10, debtToEquity: 50,  returnOnEquity: 0.25, psRatio: 5.0,  fcfYield: 0.03 },
  Healthcare:             { peRatio: 22.0, pbRatio: 4.0,  profitMargins: 0.12, revenueGrowth: 0.07, debtToEquity: 60,  returnOnEquity: 0.15, psRatio: 3.0,  fcfYield: 0.05 },
  Financials:             { peRatio: 12.0, pbRatio: 1.2,  profitMargins: 0.20, revenueGrowth: 0.05, debtToEquity: 200, returnOnEquity: 0.12, psRatio: 3.5,  fcfYield: 0.08 },
  'Financial Services':   { peRatio: 12.0, pbRatio: 1.2,  profitMargins: 0.20, revenueGrowth: 0.05, debtToEquity: 200, returnOnEquity: 0.12, psRatio: 3.5,  fcfYield: 0.08 },
  'Consumer Cyclical':    { peRatio: 20.0, pbRatio: 3.5,  profitMargins: 0.07, revenueGrowth: 0.06, debtToEquity: 80,  returnOnEquity: 0.18, psRatio: 1.5,  fcfYield: 0.05 },
  'Consumer Defensive':   { peRatio: 18.0, pbRatio: 3.0,  profitMargins: 0.08, revenueGrowth: 0.04, debtToEquity: 70,  returnOnEquity: 0.15, psRatio: 1.2,  fcfYield: 0.06 },
  Industrials:            { peRatio: 18.0, pbRatio: 3.0,  profitMargins: 0.09, revenueGrowth: 0.06, debtToEquity: 90,  returnOnEquity: 0.16, psRatio: 1.8,  fcfYield: 0.05 },
  Energy:                 { peRatio: 12.0, pbRatio: 1.8,  profitMargins: 0.10, revenueGrowth: 0.04, debtToEquity: 50,  returnOnEquity: 0.12, psRatio: 1.3,  fcfYield: 0.08 },
  Utilities:              { peRatio: 16.0, pbRatio: 1.5,  profitMargins: 0.12, revenueGrowth: 0.03, debtToEquity: 120, returnOnEquity: 0.10, psRatio: 2.0,  fcfYield: 0.03 },
  'Real Estate':          { peRatio: 30.0, pbRatio: 2.0,  profitMargins: 0.25, revenueGrowth: 0.05, debtToEquity: 100, returnOnEquity: 0.08, psRatio: 6.0,  fcfYield: 0.04 },
  'Communication Services':{ peRatio: 20.0, pbRatio: 3.5, profitMargins: 0.15, revenueGrowth: 0.07, debtToEquity: 70,  returnOnEquity: 0.18, psRatio: 3.0,  fcfYield: 0.05 },
  'Basic Materials':      { peRatio: 20.0, pbRatio: 3.0,  profitMargins: 0.12, revenueGrowth: 0.06, debtToEquity: 75,  returnOnEquity: 0.15, psRatio: 1.5,  fcfYield: 0.05 },
  Materials:              { peRatio: 20.0, pbRatio: 3.0,  profitMargins: 0.12, revenueGrowth: 0.06, debtToEquity: 75,  returnOnEquity: 0.15, psRatio: 1.5,  fcfYield: 0.05 },
  _default:               { peRatio: 20.0, pbRatio: 3.0,  profitMargins: 0.12, revenueGrowth: 0.06, debtToEquity: 75,  returnOnEquity: 0.15, psRatio: 3.0,  fcfYield: 0.04 },
};

function impute(
  fieldName: string,
  value: number | null | undefined,
  sector: string,
  imputedFields: string[]
): number | null {
  if (value !== null && value !== undefined && !isNaN(value) && value !== 0) {
    return value;
  }
  const medians = SECTOR_MEDIANS[sector] ?? SECTOR_MEDIANS._default;
  const median = medians[fieldName];
  if (median === undefined) return value ?? null;
  logger.warn(`${fieldName} missing/zero, imputed sector median ${median}`, { sector });
  imputedFields.push(fieldName);
  return median;
}

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Earnings Surprise Metrics (4Q average)
// ---------------------------------------------------------------------------
function extractEarningsSurprises(earningsData: any): {
  epsSurpriseAvg4Q: number | null;
  revenueSurpriseAvg4Q: number | null;
  quarterCount: number;
} {
  const surprises = { epsSurpriseAvg4Q: null as number | null, revenueSurpriseAvg4Q: null as number | null, quarterCount: 0 };

  try {
    if (!earningsData || typeof earningsData !== 'object') return surprises;

    const history = (earningsData.earningsHistory || earningsData.history || []) as any[];
    if (!history || history.length === 0) return surprises;

    const epsSurprises: number[] = [];
    const revenueSurprises: number[] = [];

    const recentQuarters = history.slice(0, 4);

    for (const quarter of recentQuarters) {
      let epsSurprise: number | null = null;
      if (quarter.surprisePercent !== null && quarter.surprisePercent !== undefined) {
        epsSurprise = safeNum(quarter.surprisePercent);
      } else if (quarter.epsActual !== null && quarter.epsEstimate !== null && safeNum(quarter.epsEstimate) !== 0) {
        const actual = safeNum(quarter.epsActual);
        const estimate = safeNum(quarter.epsEstimate);
        if (actual !== null && estimate !== null && estimate !== 0) {
          epsSurprise = ((actual - estimate) / Math.abs(estimate)) * 100;
        }
      }
      if (epsSurprise !== null) epsSurprises.push(epsSurprise);

      let revenueSurprise: number | null = null;
      if (quarter.revenueSurprisePercent !== null && quarter.revenueSurprisePercent !== undefined) {
        revenueSurprise = safeNum(quarter.revenueSurprisePercent);
      } else if (quarter.revenueActual !== null && quarter.revenueEstimate !== null && safeNum(quarter.revenueEstimate) !== 0) {
        const actual = safeNum(quarter.revenueActual);
        const estimate = safeNum(quarter.revenueEstimate);
        if (actual !== null && estimate !== null && estimate !== 0) {
          revenueSurprise = ((actual - estimate) / Math.abs(estimate)) * 100;
        }
      }
      if (revenueSurprise !== null) revenueSurprises.push(revenueSurprise);
    }

    surprises.quarterCount = recentQuarters.length;

    if (epsSurprises.length > 0) {
      surprises.epsSurpriseAvg4Q = Math.round((epsSurprises.reduce((a, b) => a + b, 0) / epsSurprises.length) * 100) / 100;
    }
    if (revenueSurprises.length > 0) {
      surprises.revenueSurpriseAvg4Q = Math.round((revenueSurprises.reduce((a, b) => a + b, 0) / revenueSurprises.length) * 100) / 100;
    }
  } catch (err) {
    logger.warn('Error extracting earnings surprises', { error: err });
  }

  return surprises;
}

// ---------------------------------------------------------------------------
// Short Interest Metrics
// ---------------------------------------------------------------------------
function extractShortInterestMetrics(keyStats: any, detail: any): {
  shortFloatPct: number | null;
  daysToCover: number | null;
} {
  const metrics = { shortFloatPct: null as number | null, daysToCover: null as number | null };

  try {
    let shortFloat = safeNum(keyStats.shortPercentOfFloat ?? detail.shortPercentOfFloat);
    if (shortFloat !== null && shortFloat !== 0) {
      metrics.shortFloatPct = Math.round(shortFloat * 10000) / 10000;
    }

    let daysTocover = safeNum(keyStats.shortRatio ?? keyStats.daysToCover);
    if (daysTocover !== null && daysTocover > 0) {
      metrics.daysToCover = Math.round(daysTocover * 100) / 100;
    }
  } catch (err) {
    logger.warn('Error extracting short interest metrics', { error: err });
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Insider Transaction Metrics (SEC Form 4, 90-day window)
// ---------------------------------------------------------------------------
function extractInsiderMetrics(
  insiderTxData: any,
  sharesOutstanding: number | null
): {
  insiderNetSellRatio90d: number | null;
  insiderTxCount90d: number | null;
} {
  const result = {
    insiderNetSellRatio90d: null as number | null,
    insiderTxCount90d: null as number | null,
  };

  try {
    const transactions = insiderTxData?.transactions;
    if (!Array.isArray(transactions) || transactions.length === 0) return result;

    const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
    let sellShares = 0;
    let buyShares = 0;
    let txCount = 0;

    for (const tx of transactions) {
      const txDate = tx.startDate instanceof Date ? tx.startDate : new Date(tx.startDate);
      if (isNaN(txDate.getTime()) || txDate.getTime() < cutoffMs) continue;

      const shares = Math.abs(safeNum(tx.shares) ?? 0);
      const text = (tx.transactionText ?? '').toLowerCase();

      if (text.includes('sale') || text.includes('sell')) {
        sellShares += shares;
      } else if (text.includes('purchase') || text.includes('buy')) {
        buyShares += shares;
      }
      // Option exercises excluded — not a clean directional signal

      txCount++;
    }

    result.insiderTxCount90d = txCount;

    if (sharesOutstanding && sharesOutstanding > 0) {
      const netSold = sellShares - buyShares;
      // Clip to [-1, 1] to match Python-side clamp
      result.insiderNetSellRatio90d = Math.max(-1, Math.min(1,
        Math.round((netSold / sharesOutstanding) * 1e6) / 1e6
      ));
    }
  } catch (err) {
    logger.warn('Error extracting insider metrics', { error: err });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Data fetching helpers
// ---------------------------------------------------------------------------
async function fetchOptionsData(ticker: string): Promise<any> {
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (internalSecret) {
      headers['x-api-key'] = internalSecret;
    }

    const response = await fetch(`${baseUrl}/api/stock_data/${ticker}/options`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Options fetch failed with status ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    logger.warn(`Failed to fetch options data for ${ticker}`, { error: err });
    return {
      ticker,
      available: false,
      iv: null,
      ivRank: null,
      putCallRatio: null,
      optionsChainSize: 0,
      dataQuality: {
        ivAvailable: false,
        ivRankAvailable: false,
        putCallRatioAvailable: false,
      },
    };
  }
}

async function fetchWorldBankData(forceRefresh: boolean = false): Promise<any> {
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (internalSecret) {
      headers['x-api-key'] = internalSecret;
    }

    const url = forceRefresh ? `${baseUrl}/api/worldbank?refresh=true` : `${baseUrl}/api/worldbank`;
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`World Bank data fetch failed with status ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    logger.warn('Failed to fetch World Bank data', { error: err });
    return null;
  }
}

async function fetchOhlcv(ticker: string) {
  const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const chartResult = await yahooFinance.chart(ticker, { period1: fiveYearsAgo, period2: today, interval: '1d' });
  const rows = chartResult.quotes;
  if (!rows || rows.length === 0) {
    throw new Error(`No historical data returned for ${ticker}`);
  }

  const sorted = [...rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const historyDays = sorted.length;
  if (historyDays < 30) {
    throw new Error(
      `Insufficient history for ${ticker}: ${historyDays} days available, minimum 30 required.`
    );
  }

  const historicalData = sorted.map(r => ({
    date:   new Date(r.date).toISOString().slice(0, 10),
    open:   r.open   ?? 0,
    high:   r.high   ?? 0,
    low:    r.low    ?? 0,
    close:  r.adjclose ?? r.close ?? 0,
    volume: r.volume ?? 0,
  }));

  // Tickers with < 365 days (recent IPOs, etc.) can still run the statistical
  // fallback model — flag them so the prediction route skips the ML model.
  const shortHistory = historyDays < 365;

  return { historicalData, historyDays, shortHistory };
}

async function fetchMacroSeries(sym: string): Promise<{ date: string; close: number }[]> {
  const cached = macroCache.get(sym);
  if (cached) return cached;

  try {
    const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const chartResult = await yahooFinance.chart(sym, { period1: fiveYearsAgo, period2: today, interval: '1d' });
    const rows = chartResult.quotes;

    if (!rows || rows.length === 0) return [];

    const data = rows
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(r => ({
        date:  new Date(r.date).toISOString().slice(0, 10),
        close: r.adjclose ?? r.close ?? 0,
      }));

    macroCache.set(sym, data);
    return data;
  } catch (err) {
    logger.warn(`Failed to fetch macro series ${sym}`, { error: err });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheck = checkOrigin(request);
    if (originCheck) return originCheck;

    const session = await getServerSession(authOptions);
    if (!session?.user) return unauthorizedResponse('Authentication required');
    const approvalOutcome = await checkApprovalGuard(session.user.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
  }

  const { ticker: rawTicker } = await params;
  let validatedTicker: string;
  try {
    validatedTicker = tickerSchema.parse(rawTicker);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues[0]?.message ?? 'Invalid ticker';
      return validationErrorResponse(msg);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  // Check cache unless refresh is requested
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  if (!forceRefresh) {
    const cached = getCached(validatedTicker);
    if (cached) {
      return NextResponse.json({ ...cached as any, source: 'cache' });
    }
  }

  try {
    // ---- 1. Fetch OHLCV (5 years) ----
    const { historicalData, historyDays, shortHistory } = await fetchOhlcv(validatedTicker);
    const historyYears = Math.round((historyDays / 252) * 10) / 10;

    // ---- 2. Fetch fundamentals + analyst targets (single quoteSummary call) ----
    let summary: any = {};
    let earningsModule: any = {};
    try {
      summary = await yahooFinance.quoteSummary(validatedTicker, {
        modules: [
          'price',
          'summaryDetail',
          'financialData',
          'defaultKeyStatistics',
          'recommendationTrend',
          'calendarEvents',
          'earningsHistory',
          'earningsTrend',
          'upgradeDowngradeHistory',
          'institutionOwnership',
          'majorHoldersBreakdown',
        ] as any,
      });
    } catch (err) {
      logger.warn(`Failed to fetch quoteSummary for ${validatedTicker}`, { error: err });
      summary = {};
    }

    // ---- 2b. Fetch earnings history separately ----
    try {
      const earningsSummary = await yahooFinance.quoteSummary(validatedTicker, {
        modules: ['earnings'],
      });
      earningsModule = (earningsSummary as any).earnings ?? {};
    } catch (err) {
      logger.warn(`Failed to fetch earnings module for ${validatedTicker}`, { error: err });
      earningsModule = {};
    }

    let liveQuote: any = {};
    try {
      liveQuote = await yahooFinance.quote(validatedTicker);
    } catch (err) {
      logger.warn(`Failed to fetch live quote for ${validatedTicker}`, { error: err });
    }

    const price    = (summary as any).price            ?? {};
    const detail   = (summary as any).summaryDetail     ?? {};
    const finData  = (summary as any).financialData     ?? {};
    const keyStats = (summary as any).defaultKeyStatistics ?? {};
    const calendar = (summary as any).calendarEvents    ?? {};

    let resolvedSector: string = '_default';
    try {
      const assetSummary = await yahooFinance.quoteSummary(validatedTicker, {
        modules: ['assetProfile'],
      });
      resolvedSector = (assetSummary as any)?.assetProfile?.sector ?? (price.sector ?? finData.sector ?? '_default');
    } catch (err) {
      logger.warn(`Failed to fetch assetProfile for ${validatedTicker}, using fallback sector`, { error: err });
      resolvedSector = price.sector ?? finData.sector ?? '_default';
    }

    const imputedFields: string[] = [];

    const peRatio       = impute('peRatio',       safeNum(detail.trailingPE      ?? price.trailingPE),      resolvedSector, imputedFields);
    const pbRatio       = impute('pbRatio',        safeNum(keyStats.priceToBook  ?? detail.priceToBook),    resolvedSector, imputedFields);
    const profitMargins = impute('profitMargins',  safeNum(finData.profitMargins),                          resolvedSector, imputedFields);
    const revenueGrowth = impute('revenueGrowth',  safeNum(finData.revenueGrowth),                          resolvedSector, imputedFields);
    const debtToEquity  = impute('debtToEquity',   safeNum(finData.debtToEquity),                           resolvedSector, imputedFields);
    const returnOnEquity = impute('returnOnEquity', safeNum(finData.returnOnEquity),                         resolvedSector, imputedFields);

    const analystTargetMean   = safeNum(finData.targetMeanPrice);
    const analystTargetMedian = safeNum(finData.targetMedianPrice);
    const analystTargetHigh   = safeNum(finData.targetHighPrice);
    const analystTargetLow    = safeNum(finData.targetLowPrice);
    const analystOpinionCount = safeNum(finData.numberOfAnalystOpinions) ?? 0;
    const recommendationMean  = safeNum(finData.recommendationMean);
    const currentPrice        = safeNum(liveQuote.regularMarketPrice ?? price.regularMarketPrice);
    const analystUpside       = analystTargetMean && currentPrice && analystTargetMean > 0 ? (analystTargetMean - currentPrice) / currentPrice : 0;
    
    // Fallback for fiftyTwoWeekChange: calculate from historicalData if missing
    let fiftyTwoWeekChange = safeNum(keyStats.fiftyTwoWeekChange);
    if (fiftyTwoWeekChange === null && historicalData && historicalData.length >= 252) {
      // Use price ~252 trading days ago
      const priceNow = historicalData[historicalData.length - 1].close;
      const priceYearAgo = historicalData[historicalData.length - 252].close;
      if (priceYearAgo > 0) {
        fiftyTwoWeekChange = (priceNow - priceYearAgo) / priceYearAgo;
      }
    }

    const nextEarningsDateMs = calendar?.earnings?.[0]?.earningsDate;
    const nextEarningsDate = nextEarningsDateMs
      ? new Date(nextEarningsDateMs * 1000).toISOString().slice(0, 10)
      : null;

    // ── earningsHistory: precise last 8 earnings dates ──
    const earningsHist = (summary as any).earningsHistory?.history ?? [];
    const lastEarningsDate = earningsHist[0]?.quarter instanceof Date
      ? earningsHist[0].quarter.toISOString()
      : earningsHist[0]?.quarter
        ? new Date(earningsHist[0].quarter * 1000).toISOString()
        : null;

    const earningsDateHistory = earningsHist.slice(0, 8).map((e: any) => {
      const d = e.quarter instanceof Date ? e.quarter : (e.quarter ? new Date(e.quarter * 1000) : null);
      return {
        date: d?.toISOString() ?? null,
        surprise: e.surprisePercent ?? null,
      };
    }).filter((e: any) => e.date !== null);

    // ── earningsTrend: EPS revision velocity ──
    const trend0 = (summary as any).earningsTrend?.trend?.[0]; // current quarter
    const trend1 = (summary as any).earningsTrend?.trend?.[1]; // next quarter

    function safeDivide(a: number | null | undefined, b: number | null | undefined): number | null {
      if (a == null || b == null || Math.abs(b) < 1e-9) return null;
      return (a - b) / Math.abs(b + 0.01);
    }

    const epsRevision7d_0Q = safeDivide(
      trend0?.epsTrend?.current,
      trend0?.epsTrend?.['7daysAgo']
    );
    const epsRevision7d_1Q = safeDivide(
      trend1?.epsTrend?.current,
      trend1?.epsTrend?.['7daysAgo']
    );
    const epsRevisionsUp7d   = trend0?.epsRevisions?.upLast7days   ?? null;
    const epsRevisionsDown7d = trend0?.epsRevisions?.downLast7days ?? null;
    const revenueEstGrowth_0Q = trend0?.revenueEstimate?.growth ?? null;
    const revenueEstGrowth_1Q = trend1?.revenueEstimate?.growth ?? null;

    // ── upgradeDowngradeHistory: analyst action recency ──
    const upgradeHist = (summary as any).upgradeDowngradeHistory?.history ?? [];
    const nowMs = Date.now();
    const MS_7D  = 7  * 86400000;
    const MS_30D = 30 * 86400000;
    const MS_90D = 90 * 86400000;

    function upgradeScore(history: any[], windowMs: number): number {
      const recent = history.filter((h: any) => {
        const ms = h.epochGradeDate ? h.epochGradeDate * 1000 : 0;
        return (nowMs - ms) < windowMs;
      });
      if (!recent.length) return 0;
      const ups   = recent.filter((h: any) => h.action === 'up').length;
      const downs = recent.filter((h: any) => h.action === 'down').length;
      return (ups - downs) / recent.length;
    }

    // Phase 2 (Tier 1) — raw rating action counts. The normalized upgradeScore
    // above collapses "5 ups + 5 downs" and "0 events" both to 0; the model
    // benefits from seeing volume separately from net sign. 90d window catches
    // slower-moving analyst repositioning that the 30d misses.
    function ratingCounts(history: any[], windowMs: number): { up: number; down: number } {
      const recent = history.filter((h: any) => {
        const ms = h.epochGradeDate ? h.epochGradeDate * 1000 : 0;
        return (nowMs - ms) < windowMs;
      });
      return {
        up:   recent.filter((h: any) => h.action === 'up').length,
        down: recent.filter((h: any) => h.action === 'down').length,
      };
    }

    const upgradeScore7d  = upgradeScore(upgradeHist, MS_7D);
    const upgradeScore30d = upgradeScore(upgradeHist, MS_30D);
    const upgradeScore90d = upgradeScore(upgradeHist, MS_90D);
    const rc30 = ratingCounts(upgradeHist, MS_30D);
    const rc90 = ratingCounts(upgradeHist, MS_90D);

    // ── institutionOwnership: Q-o-Q institutional delta ──
    const ownersList = (summary as any).institutionOwnership?.ownershipList ?? [];
    const instPctHeld  = ownersList[0]?.pctHeld ?? null;
    const instPctDelta = ownersList.length >= 2
      ? (ownersList[0]?.pctHeld ?? 0) - (ownersList[1]?.pctHeld ?? ownersList[0]?.pctHeld ?? 0)
      : null;
    const mhBreakdown = (summary as any).majorHoldersBreakdown ?? {};
    const insiderPctHeld    = mhBreakdown.insidersPercentHeld    ?? null;
    const institutionCount  = mhBreakdown.institutionsCount      ?? null;

    // ── liveQuote: pre/post market + fresh 52w position ──
    const preMarketChangePct  = liveQuote.preMarketChangePercent  ?? null;
    const postMarketChangePct = liveQuote.postMarketChangePercent ?? null;
    const fw52Low  = liveQuote.fiftyTwoWeekLow  ?? null;
    const fw52High = liveQuote.fiftyTwoWeekHigh ?? null;
    const fiftyTwoWeekPosRatio = (fw52Low !== null && fw52High !== null && (fw52High - fw52Low) > 0 && currentPrice !== null)
      ? (currentPrice - fw52Low) / (fw52High - fw52Low)
      : null;
    const avgDailyVol3M = liveQuote.averageDailyVolume3Month ?? null;

    // ── Item 08: Peer relative strength (5d) ──
    let peerRS5d: number | null = null;
    try {
      const peersResult = await (yahooFinance as any).recommendationsBySymbol(validatedTicker);
      const peerSymbols: string[] = (peersResult?.recommendedSymbols ?? [])
        .slice(0, 5)
        .map((p: any) => p.symbol)
        .filter(Boolean);

      if (peerSymbols.length > 0) {
        const peerQuotes = await Promise.all(
          peerSymbols.map((s: string) => yahooFinance.quote(s).catch(() => null))
        );
        const validPeerQuotes = peerQuotes.filter(Boolean) as any[];
        if (validPeerQuotes.length > 0) {
          const peerAvg5d = validPeerQuotes.reduce((sum: number, q: any) =>
            sum + (q.regularMarketChangePercent ?? 0), 0) / validPeerQuotes.length;
          const stockReturn5d = (liveQuote.regularMarketChangePercent ?? 0);
          peerRS5d = stockReturn5d - peerAvg5d;
        }
      }
    } catch (err) {
      logger.warn(`Failed to fetch peer relative strength for ${validatedTicker}`, { error: err });
    }

    const stockMetrics = {
      regularMarketPrice: currentPrice,
      peRatio,
      pbRatio,
      marketCap:          safeNum(price.marketCap  ?? detail.marketCap),
      trailingEps:        safeNum(keyStats.trailingEps),
      forwardEps:         safeNum(keyStats.forwardEps),
      revenueGrowth,
      earningsGrowth:     safeNum(finData.earningsGrowth),
      profitMargins,
      freeCashflow:       safeNum(finData.freeCashflow),
      debtToEquity,
      returnOnEquity,
      dividendYield:      safeNum(detail.dividendYield),
      beta:               safeNum(keyStats.beta ?? detail.beta),
      sector:             resolvedSector,
      // Phase 1 (Tier 1) additions — surface Yahoo snapshot fields the Python
      // feature builder derives new signals from: FCF_Yield (FCF/MarketCap),
      // IV_HV_Ratio (already have both inputs), PriceToSales, EV_EBITDA,
      // EV_Revenue, CashRunwayQuarters, Unprofitable_Flag. All present and
      // reliable on the Yahoo side across the ticker universe we care about
      // — no new data provider required.
      priceToSales:       safeNum(detail.priceToSalesTrailing12Months),
      enterpriseValue:    safeNum(keyStats.enterpriseValue),
      enterpriseToEbitda: safeNum(keyStats.enterpriseToEbitda),
      enterpriseToRevenue: safeNum(keyStats.enterpriseToRevenue),
      totalCash:          safeNum(finData.totalCash),
      totalDebt:          safeNum(finData.totalDebt),
      operatingCashflow:  safeNum(finData.operatingCashflow),
      // Phase 2 (Tier 2) — sector medians surfaced so the Python feature
      // builder can compute log-ratios (this stock's PE vs its sector median,
      // etc.). Uses the same static SECTOR_MEDIANS table the imputation lane
      // already consults — stable enough for the cross-sectional signal we
      // want, no infrastructure to maintain.
      sectorMedianPe:            (SECTOR_MEDIANS[resolvedSector] ?? SECTOR_MEDIANS._default).peRatio,
      sectorMedianPb:            (SECTOR_MEDIANS[resolvedSector] ?? SECTOR_MEDIANS._default).pbRatio,
      sectorMedianRevenueGrowth: (SECTOR_MEDIANS[resolvedSector] ?? SECTOR_MEDIANS._default).revenueGrowth,
      sectorMedianProfitMargins: (SECTOR_MEDIANS[resolvedSector] ?? SECTOR_MEDIANS._default).profitMargins,
      // green_v2 — PS and FCF Yield sector medians. Static fallbacks used
      // until the sector_median_history table is populated (nightly job).
      // Typical values by sector, hand-calibrated from cross-sectional averages.
      sectorMedianPs:            (SECTOR_MEDIANS[resolvedSector] ?? SECTOR_MEDIANS._default).psRatio ?? 3.0,
      sectorMedianFcfYield:      (SECTOR_MEDIANS[resolvedSector] ?? SECTOR_MEDIANS._default).fcfYield ?? 0.04,
      analystTargetMean,
      analystTargetMedian,
      analystTargetHigh,
      analystTargetLow,
      analystOpinionCount: Math.round(analystOpinionCount),
      recommendationMean,
      recommendationKey:  (finData.recommendationKey as string | null) ?? null,
      analystUpside,
      fiftyTwoWeekChange,
      nextEarningsDate,
      lastEarningsDate,
    };

    // ---- 2c. Fetch insider transactions (Form 4, 90-day window) ----
    let insiderTxModule: any = null;
    try {
      const insiderSummary = await yahooFinance.quoteSummary(validatedTicker, {
        modules: ['insiderTransactions'] as any,
      });
      insiderTxModule = (insiderSummary as any).insiderTransactions ?? null;
    } catch (err) {
      logger.warn(`Failed to fetch insiderTransactions for ${validatedTicker}`, { error: err });
    }

    const surprises = extractEarningsSurprises(earningsModule);
    const shortInterest = extractShortInterestMetrics(keyStats, detail);
    const sharesOutstanding = safeNum(keyStats.sharesOutstanding);
    const insiderMetrics = extractInsiderMetrics(insiderTxModule, sharesOutstanding);

    // ── Phase 2 (Tier 1) — Analyst estimate history snapshot + revisions ─────
    // Yahoo only returns current snapshots for targetMeanPrice and EPS
    // estimates. To compute revisions we persist a daily row here (upsert on
    // (symbol, snapshot_date)) and compute the delta vs a row ~30 days ago.
    // Revisions are null until we have at least ~25 days of history, at which
    // point they start contributing signal.
    const epsEstCurrQ = safeNum(trend0?.earningsEstimate?.avg);
    const epsEstNextQ = safeNum(trend1?.earningsEstimate?.avg);
    let targetMeanRevision30d: number | null = null;
    let epsEstRevision30dCurrQ: number | null = null;
    let epsEstRevision30dNextQ: number | null = null;
    try {
      // Read the row nearest 30 days ago (window: 25-35 days) so a missing
      // day doesn't null out the feature.
      const [prevRows] = await executeRawQuery(
        `SELECT target_mean, eps_est_curr_q, eps_est_next_q
         FROM analyst_estimate_history
         WHERE symbol = ?
           AND snapshot_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 35 DAY)
                                 AND DATE_SUB(CURDATE(), INTERVAL 25 DAY)
         ORDER BY snapshot_date DESC LIMIT 1`,
        [validatedTicker]
      );
      const prev = (prevRows as any[])[0];
      if (prev) {
        if (analystTargetMean != null && prev.target_mean != null && Number(prev.target_mean) > 0) {
          targetMeanRevision30d = analystTargetMean / Number(prev.target_mean) - 1;
        }
        if (epsEstCurrQ != null && prev.eps_est_curr_q != null && Number(prev.eps_est_curr_q) !== 0) {
          epsEstRevision30dCurrQ = (epsEstCurrQ - Number(prev.eps_est_curr_q)) / Math.abs(Number(prev.eps_est_curr_q));
        }
        if (epsEstNextQ != null && prev.eps_est_next_q != null && Number(prev.eps_est_next_q) !== 0) {
          epsEstRevision30dNextQ = (epsEstNextQ - Number(prev.eps_est_next_q)) / Math.abs(Number(prev.eps_est_next_q));
        }
      }

      // Upsert today's snapshot. INSERT ... ON DUPLICATE so a second request
      // in the same day is idempotent, and REPLACE the values in case Yahoo
      // updated its estimates intraday.
      await executeRawQuery(
        `INSERT INTO analyst_estimate_history
           (symbol, snapshot_date, target_mean, target_median, target_high, target_low,
            eps_est_curr_q, eps_est_next_q, recommendation_mean, analyst_opinion_count)
         VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           target_mean = VALUES(target_mean),
           target_median = VALUES(target_median),
           target_high = VALUES(target_high),
           target_low = VALUES(target_low),
           eps_est_curr_q = VALUES(eps_est_curr_q),
           eps_est_next_q = VALUES(eps_est_next_q),
           recommendation_mean = VALUES(recommendation_mean),
           analyst_opinion_count = VALUES(analyst_opinion_count)`,
        [
          validatedTicker,
          analystTargetMean, analystTargetMedian, analystTargetHigh, analystTargetLow,
          epsEstCurrQ, epsEstNextQ,
          recommendationMean, analystOpinionCount,
        ]
      );
    } catch (err) {
      logger.warn(`analyst_estimate_history r/w failed for ${validatedTicker}`, { error: err });
    }

    // ── Phase 2 (Tier 2) — Google Trends momentum ────────────────────────────
    // Spawn the pytrends helper with a hard 6s timeout. On failure or slow
    // response, feature is null and the Python model treats it as missing.
    // Cached aggressively (30 days) so this typically returns in <100ms.
    let searchInterest_20d_change: number | null = null;
    try {
      searchInterest_20d_change = await new Promise<number | null>((resolve) => {
        const proc = spawn(getPythonExecutable(), [
          'scripts/trends_helper.py', validatedTicker,
        ]);
        let stdout = '';
        const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 6000);
        proc.stdout.on('data', d => { stdout += d; });
        proc.on('close', () => {
          clearTimeout(t);
          try {
            const parsed = JSON.parse(stdout);
            resolve(parsed?.searchInterest_20d_change ?? null);
          } catch {
            resolve(null);
          }
        });
        proc.on('error', () => { clearTimeout(t); resolve(null); });
      });
    } catch {
      searchInterest_20d_change = null;
    }

    const featureMetrics = {
      epsSurpriseAvg4Q: surprises.epsSurpriseAvg4Q,
      revenueSurpriseAvg4Q: surprises.revenueSurpriseAvg4Q,
      shortFloatPct: shortInterest.shortFloatPct,
      daysToCover: shortInterest.daysToCover,
      insiderNetSellRatio90d: insiderMetrics.insiderNetSellRatio90d,
      insiderTxCount90d: insiderMetrics.insiderTxCount90d,
      // ── Item 01 & 02: Earnings dates ──
      lastEarningsDate,
      earningsDateHistory,
      // ── Item 03: EPS revision velocity ──
      epsRevision7d_0Q,
      epsRevision7d_1Q,
      epsRevisionsUp7d,
      epsRevisionsDown7d,
      revenueEstGrowth_0Q,
      revenueEstGrowth_1Q,
      // ── Item 04: Analyst upgrade/downgrade recency ──
      upgradeScore7d,
      upgradeScore30d,
      // Phase 2 (Tier 1): raw counts + 90d net
      upgradeScore90d,
      ratingUp30d:   rc30.up,
      ratingDown30d: rc30.down,
      ratingUp90d:   rc90.up,
      ratingDown90d: rc90.down,
      // Phase 2 (Tier 1): analyst estimate revisions (nullable until ~30d of history)
      targetMeanRevision30d,
      epsEstRevision30dCurrQ,
      epsEstRevision30dNextQ,
      // Phase 2 (Tier 2): Google Trends momentum (nullable when API failed / rate-limited)
      searchInterest_20d_change,
      // ── Item 05: Pre/post-market gap + 52w position ──
      preMarketChangePct,
      postMarketChangePct,
      fiftyTwoWeekPosRatio,
      avgDailyVol3M,
      // ── Item 06: Institution ownership ──
      instPctHeld,
      instPctDelta,
      insiderPctHeld,
      institutionCount,
      // ── Item 08: Peer relative strength ──
      peerRS5d,
      asOf: new Date().toISOString().slice(0, 10),
    };

    const optionsData = await fetchOptionsData(validatedTicker);

    const sectorEtfSym = SECTOR_ETF[resolvedSector] ?? 'SPY';
    const [vixData, tnxData, etfData, hygData, lqdData, dxyData, spyData, irxData, wtiData, copperData, wheatData] = await Promise.all([
      fetchMacroSeries('^VIX'),
      fetchMacroSeries('^TNX'),
      fetchMacroSeries(sectorEtfSym),
      fetchMacroSeries('HYG'),
      fetchMacroSeries('LQD'),
      fetchMacroSeries('DX-Y.NYB'),
      fetchMacroSeries('SPY'),
      fetchMacroSeries('^IRX'),
      fetchMacroSeries('CL=F'),
      fetchMacroSeries('HG=F'),
      fetchMacroSeries('ZW=F'),
    ]);

    let worldBankData = null;
    const wbResponse = await fetchWorldBankData(forceRefresh);
    if (wbResponse && wbResponse.success && wbResponse.macro) {
      worldBankData = {
        indicators: wbResponse.macro.indicators,
        asOf: wbResponse.asOf
      };
    }

    const macroData = {
      vix:         vixData,
      treasury10y: tnxData,
      sectorEtf:   { ticker: sectorEtfSym, data: etfData },
      hyg:         hygData,
      lqd:         lqdData,
      dxy:         dxyData,
      spy:         spyData,
      treasury3m:  irxData,
      wti:         wtiData,
      copper:      copperData,
      wheat:       wheatData,
      worldBank:   worldBankData,
    };

    let historicalEarnings: any[] = [];
    try {
      const earningsSummary = await yahooFinance.quoteSummary(validatedTicker, {
        modules: ['earnings'],
      });
      const earningsData = (earningsSummary as any).earnings;
      const earningsMap = new Map<string, any>();

      earningsData?.earningsChart?.quarterly?.forEach((q: any) => {
        earningsMap.set(q.date, {
          date:        q.date,
          epsActual:   safeNum(q.actual),
          epsEstimate: safeNum(q.estimate),
          revenue:     null,
          earnings:    null,
        });
      });

      earningsData?.financialsChart?.quarterly?.forEach((q: any) => {
        const existing = earningsMap.get(q.date);
        if (existing) {
          earningsMap.set(q.date, { ...existing, revenue: safeNum(q.revenue), earnings: safeNum(q.earnings) });
        } else {
          earningsMap.set(q.date, { date: q.date, epsActual: null, epsEstimate: null, revenue: safeNum(q.revenue), earnings: safeNum(q.earnings) });
        }
      });

      historicalEarnings = Array.from(earningsMap.values()).sort((a, b) => {
        const parse = (d: string) => {
          const m = d.match(/(\d)Q(\d{4})/);
          return m ? parseInt(m[2]) * 10 + parseInt(m[1]) : 0;
        };
        return parse(b.date) - parse(a.date);
      });
    } catch (err) {
      logger.warn('Failed to fetch earnings data', { error: err });
    }

    const missingFeatures: string[] = [];
    if (featureMetrics.epsSurpriseAvg4Q === null) missingFeatures.push('epsSurpriseAvg4Q');
    if (featureMetrics.revenueSurpriseAvg4Q === null) missingFeatures.push('revenueSurpriseAvg4Q');
    if (featureMetrics.shortFloatPct === null) missingFeatures.push('shortFloatPct');
    if (featureMetrics.daysToCover === null) missingFeatures.push('daysToCover');
    if (featureMetrics.insiderNetSellRatio90d === null) missingFeatures.push('insiderNetSellRatio90d');
    if (featureMetrics.insiderTxCount90d === null) missingFeatures.push('insiderTxCount90d');

    const dataQuality = {
      historyDays,
      historyYears,
      shortHistory,
      fundamentalsComplete: imputedFields.length === 0,
      analystDataAvailable: analystTargetMean !== null && analystOpinionCount > 0,
      macroDataAvailable:   vixData.length > 0 || tnxData.length > 0,
      imputedFields,
      missingFeatureMetrics: missingFeatures.length > 0 ? missingFeatures : undefined,
      earningsSurpriseQuarterCount: surprises.quarterCount,
    };

    // Compute technical score server-side so scripts/update_predictions.py receives
    // the same value that the web UI passes to the GPS formula.
    // newsData omitted here (news endpoint is separate) → newsScore defaults to 0.
    const technicalIndicators = calculateTechnicalIndicators(
      historicalData,
      [],
      stockMetrics.peRatio ?? undefined,
      stockMetrics.pbRatio ?? undefined,
      stockMetrics.marketCap ?? undefined,
    );
    const technicalScore = technicalIndicators.scoreBreakdown.totalScore;

    // ── Per-period analyst recommendation history (for analyst_sentiment v2) ──
    // yahoo-finance2 returns this in summary.recommendationTrend.trend. Shape:
    //   [{ period: '0m', strongBuy: 4, buy: 11, hold: 8, sell: 0, strongSell: 0 }, ...]
    // The Python sentiment module reads this for the time-weighted RecScore.
    // Empty/missing → graceful fallback to v1 path inside predict_weighted_analysis.
    const recommendationsHistory: Array<Record<string, number | string>> = [];
    try {
      const trend = (summary as any)?.recommendationTrend?.trend;
      if (Array.isArray(trend)) {
        for (const row of trend) {
          if (!row || typeof row !== 'object') continue;
          recommendationsHistory.push({
            period:     String(row.period ?? ''),
            strongBuy:  Number(row.strongBuy  ?? 0),
            buy:        Number(row.buy        ?? 0),
            hold:       Number(row.hold       ?? 0),
            sell:       Number(row.sell       ?? 0),
            strongSell: Number(row.strongSell ?? 0),
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to extract recommendationTrend', { ticker: validatedTicker, error: err });
    }

    const payload = {
      ticker:            validatedTicker,
      historicalData,
      stockMetrics,
      macroData,
      optionsData,
      featureMetrics,
      historicalEarnings,
      dataQuality,
      technicalScore,
      recommendationKey: stockMetrics.recommendationKey,
      recommendationsHistory,
    };

    setCache(validatedTicker, payload);
    return NextResponse.json({ ...payload, source: 'livedata' });

  } catch (err) {
    logger.error('Data fetch failed', { ticker: validatedTicker, error: err });
    return NextResponse.json({ message: 'Failed to fetch stock data' }, { status: 500 });
  }
}
