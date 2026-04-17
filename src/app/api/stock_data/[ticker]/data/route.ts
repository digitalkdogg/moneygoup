// GET /api/stock_data/[ticker]/data
// Fetches the enriched 5-year data payload used by the LSTM prediction pipeline.
// All data is gathered here (Next.js side) so scripts/predict_weighted_analysis.py
// receives a pre-assembled payload and never makes outbound network calls.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { unauthorizedResponse, validationErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';
import { macroCache } from '@/utils/cache';

const logger = createLogger('api/stock/[ticker]/data');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------------------------------------------------------------------------
// Server-side cache — 15-minute TTL, hard cap of 500 entries
// ---------------------------------------------------------------------------
const DATA_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DATA_CACHE_MAX = 500;
const dataCache = new Map<string, { data: unknown; fetchedAt: number }>();

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
  Technology:             { peRatio: 28.0, pbRatio: 6.0,  profitMargins: 0.20, revenueGrowth: 0.10, debtToEquity: 50,  returnOnEquity: 0.25 },
  Healthcare:             { peRatio: 22.0, pbRatio: 4.0,  profitMargins: 0.12, revenueGrowth: 0.07, debtToEquity: 60,  returnOnEquity: 0.15 },
  Financials:             { peRatio: 12.0, pbRatio: 1.2,  profitMargins: 0.20, revenueGrowth: 0.05, debtToEquity: 200, returnOnEquity: 0.12 },
  'Financial Services':   { peRatio: 12.0, pbRatio: 1.2,  profitMargins: 0.20, revenueGrowth: 0.05, debtToEquity: 200, returnOnEquity: 0.12 },
  'Consumer Cyclical':    { peRatio: 20.0, pbRatio: 3.5,  profitMargins: 0.07, revenueGrowth: 0.06, debtToEquity: 80,  returnOnEquity: 0.18 },
  'Consumer Defensive':   { peRatio: 18.0, pbRatio: 3.0,  profitMargins: 0.08, revenueGrowth: 0.04, debtToEquity: 70,  returnOnEquity: 0.15 },
  Industrials:            { peRatio: 18.0, pbRatio: 3.0,  profitMargins: 0.09, revenueGrowth: 0.06, debtToEquity: 90,  returnOnEquity: 0.16 },
  Energy:                 { peRatio: 12.0, pbRatio: 1.8,  profitMargins: 0.10, revenueGrowth: 0.04, debtToEquity: 50,  returnOnEquity: 0.12 },
  Utilities:              { peRatio: 16.0, pbRatio: 1.5,  profitMargins: 0.12, revenueGrowth: 0.03, debtToEquity: 120, returnOnEquity: 0.10 },
  'Real Estate':          { peRatio: 30.0, pbRatio: 2.0,  profitMargins: 0.25, revenueGrowth: 0.05, debtToEquity: 100, returnOnEquity: 0.08 },
  'Communication Services':{ peRatio: 20.0, pbRatio: 3.5, profitMargins: 0.15, revenueGrowth: 0.07, debtToEquity: 70,  returnOnEquity: 0.18 },
  'Basic Materials':      { peRatio: 20.0, pbRatio: 3.0,  profitMargins: 0.12, revenueGrowth: 0.06, debtToEquity: 75,  returnOnEquity: 0.15 },
  Materials:              { peRatio: 20.0, pbRatio: 3.0,  profitMargins: 0.12, revenueGrowth: 0.06, debtToEquity: 75,  returnOnEquity: 0.15 },
  _default:               { peRatio: 20.0, pbRatio: 3.0,  profitMargins: 0.12, revenueGrowth: 0.06, debtToEquity: 75,  returnOnEquity: 0.15 },
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
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const today = yesterday.toISOString().slice(0, 10);

  const rows = await yahooFinance.historical(ticker, { period1: fiveYearsAgo, period2: today });
  if (!rows || rows.length === 0) {
    throw new Error(`No historical data returned for ${ticker}`);
  }

  const sorted = [...rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const historyDays = sorted.length;
  if (historyDays < 504) {
    throw new Error(
      `Insufficient history for ${ticker}: ${historyDays} days available, minimum 504 required (~2 years).`
    );
  }

  const historicalData = sorted.map(r => ({
    date:   new Date(r.date).toISOString().slice(0, 10),
    open:   r.open   ?? 0,
    high:   r.high   ?? 0,
    low:    r.low    ?? 0,
    close:  r.adjClose ?? r.close ?? 0,
    volume: r.volume ?? 0,
  }));

  return { historicalData, historyDays };
}

async function fetchMacroSeries(sym: string): Promise<{ date: string; close: number }[]> {
  const cached = macroCache.get(sym);
  if (cached) return cached;

  try {
    const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const today = yesterday.toISOString().slice(0, 10);
    const rows = await yahooFinance.historical(sym, { period1: fiveYearsAgo, period2: today });
    
    if (!rows || rows.length === 0) return [];
    
    const data = rows
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(r => ({
        date:  new Date(r.date).toISOString().slice(0, 10),
        close: r.adjClose ?? r.close ?? 0,
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
  { params }: { params: { ticker: string } }
) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheck = checkOrigin(request);
    if (originCheck) return originCheck;

    const session = await getServerSession(authOptions);
    if (!session?.user) return unauthorizedResponse('Authentication required');
  }

  let validatedTicker: string;
  try {
    validatedTicker = tickerSchema.parse(params.ticker);
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
    const { historicalData, historyDays } = await fetchOhlcv(validatedTicker);
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
        ],
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

    const nextEarningsDateMs = calendar?.earnings?.[0]?.earningsDate;
    const nextEarningsDate = nextEarningsDateMs
      ? new Date(nextEarningsDateMs * 1000).toISOString().slice(0, 10)
      : null;

    const stockMetrics = {
      regularMarketPrice: safeNum(price.regularMarketPrice),
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
      analystTargetMean,
      analystTargetMedian,
      analystTargetHigh,
      analystTargetLow,
      analystOpinionCount: Math.round(analystOpinionCount),
      recommendationMean,
      nextEarningsDate,
    };

    const surprises = extractEarningsSurprises(earningsModule);
    const shortInterest = extractShortInterestMetrics(keyStats, detail);

    const featureMetrics = {
      epsSurpriseAvg4Q: surprises.epsSurpriseAvg4Q,
      revenueSurpriseAvg4Q: surprises.revenueSurpriseAvg4Q,
      shortFloatPct: shortInterest.shortFloatPct,
      daysToCover: shortInterest.daysToCover,
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

    const dataQuality = {
      historyDays,
      historyYears,
      fundamentalsComplete: imputedFields.length === 0,
      analystDataAvailable: analystTargetMean !== null && analystOpinionCount > 0,
      macroDataAvailable:   vixData.length > 0 || tnxData.length > 0,
      imputedFields,
      missingFeatureMetrics: missingFeatures.length > 0 ? missingFeatures : undefined,
      earningsSurpriseQuarterCount: surprises.quarterCount,
    };

    const payload = {
      ticker:            validatedTicker,
      historicalData,
      stockMetrics,
      macroData,
      optionsData,
      featureMetrics,
      historicalEarnings,
      dataQuality,
    };

    setCache(validatedTicker, payload);
    return NextResponse.json({ ...payload, source: 'livedata' });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch stock data';
    logger.error('Data fetch failed', { ticker: validatedTicker, error: err });
    return NextResponse.json({ message }, { status: 500 });
  }
}
