import YahooFinance from 'yahoo-finance2';
import { createLogger } from '@/utils/logger';
import { getPythonExecutable } from '@/utils/pythonPath';
import { executeRawQuery } from '@/utils/databaseHelper';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const logger = createLogger('utils/stockDataHelper');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RETRIES = 3;

function safeNum(v: any): number | null {
  if (v == null || v === '' || Number.isNaN(Number(v)) || !Number.isFinite(Number(v))) return null;
  return Number(v);
}

function safeDivide(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || Math.abs(b) < 1e-9) return null;
  return (a - b) / Math.abs(b + 0.01);
}

async function yahooChartWithRetry(ticker: string, params: any): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await (yahooFinance.chart as any)(ticker, params, { validateResult: false });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.includes('Too Many Requests') && attempt < MAX_RETRIES) {
        logger.warn(`Yahoo rate-limited on ${ticker}, waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
        continue;
      }
      logger.error(`Yahoo chart error for ${ticker}: ${msg}`);
      return { quotes: [] };
    }
  }
  return { quotes: [] };
}

async function yahooSummaryWithRetry(ticker: string, modules: any[]): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await yahooFinance.quoteSummary(ticker, { modules } as any, { validateResult: false });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.includes('Too Many Requests') && attempt < MAX_RETRIES) {
        logger.warn(`Yahoo summary rate-limited on ${ticker}, waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
        continue;
      }
      logger.warn(`Yahoo summary failed for ${ticker} (attempt ${attempt}): ${msg.slice(0, 120)}`);
      return {};
    }
  }
  return {};
}

export async function getStockDataForPrediction(ticker: string, wbData?: any) {
  const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const today = yesterday.toISOString().slice(0, 10);

  // Phase 1-3: extended module list — same single quoteSummary request, larger payload.
  // calendarEvents was already present; earningsTrend + recommendationTrend +
  // upgradeDowngradeHistory + earningsHistory activate the dead feature columns;
  // earnings activates EarningsBeatStreak via historicalEarnings.
  const SUMMARY_MODULES = [
    'price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile',
    'calendarEvents',
    'earningsTrend', 'recommendationTrend', 'upgradeDowngradeHistory', 'earningsHistory',
    'earnings',
  ];

  const [chartResult, summary] = await Promise.all([
    yahooChartWithRetry(ticker, { period1: fiveYearsAgo, period2: today, interval: '1d' }),
    yahooSummaryWithRetry(ticker, SUMMARY_MODULES),
  ]);
  const optionsRes = null;

  const summaryEmpty = !summary || Object.keys(summary).length === 0;
  if (summaryEmpty) {
    logger.warn(`quoteSummary returned empty for ${ticker} — stockMetrics will be null; CS will be degraded`);
  }

  const historicalData = (chartResult.quotes || [])
    .filter((r: any) =>
      r.open != null && r.high != null && r.low != null &&
      (r.adjClose != null || r.close != null)
    )
    .map((r: any) => ({
      date: new Date(r.date).toISOString().slice(0, 10),
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: (r.adjClose as number) ?? (r.close as number),
      volume: (r.volume as number) ?? 0,
    }));

  if (historicalData.length < 30) {
    throw new Error(`Insufficient data for ${ticker}: ${historicalData.length} rows, need >= 30.`);
  }
  const shortHistory = historicalData.length < 200;

  const price    = (summary as any).price               ?? {};
  const detail   = (summary as any).summaryDetail        ?? {};
  const finData  = (summary as any).financialData        ?? {};
  const keyStats = (summary as any).defaultKeyStatistics ?? {};
  const profile  = (summary as any).assetProfile         ?? {};
  const calendar = (summary as any).calendarEvents        ?? {};

  // ── Phase 1: calendarEvents — earnings dates ──────────────────────────────
  // calendarEvents was already in SUMMARY_MODULES but never read. Extract both
  // dates here; they feed Days_To_Next_Earnings / Days_Since_Last_Earnings /
  // Earnings_In_Window in predict_core.py with zero new Yahoo requests.
  const nextEarningsDateMs = calendar?.earnings?.[0]?.earningsDate;
  const nextEarningsDate = nextEarningsDateMs
    ? new Date(nextEarningsDateMs * 1000).toISOString().slice(0, 10)
    : null;

  const earningsHist = (summary as any).earningsHistory?.history ?? [];
  const lastEarningsDate = earningsHist[0]?.quarter instanceof Date
    ? earningsHist[0].quarter.toISOString()
    : earningsHist[0]?.quarter
      ? new Date(earningsHist[0].quarter * 1000).toISOString()
      : null;

  // ── Phase 2: earningsTrend — EPS revision velocity ───────────────────────
  const trend0 = (summary as any).earningsTrend?.trend?.[0]; // current quarter
  const trend1 = (summary as any).earningsTrend?.trend?.[1]; // next quarter

  const epsRevision7d_0Q   = safeDivide(trend0?.epsTrend?.current, trend0?.epsTrend?.['7daysAgo']);
  const epsRevision7d_1Q   = safeDivide(trend1?.epsTrend?.current, trend1?.epsTrend?.['7daysAgo']);
  const epsRevisionsUp7d   = trend0?.epsRevisions?.upLast7days   ?? null;
  const epsRevisionsDown7d = trend0?.epsRevisions?.downLast7days ?? null;
  const revenueEstGrowth_0Q = trend0?.revenueEstimate?.growth ?? null;
  const revenueEstGrowth_1Q = trend1?.revenueEstimate?.growth ?? null;

  // ── Phase 2: upgradeDowngradeHistory — rating velocity ───────────────────
  const upgradeHist = (summary as any).upgradeDowngradeHistory?.history ?? [];
  const nowMs  = Date.now();
  const MS_7D  =  7 * 86400000;
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

  // ── Phase 4: analyst_estimate_history — revision features ────────────────
  // Persist a daily snapshot per ticker so the 30-day revision features can
  // be computed. Scoped to tickers that already reach this function (i.e. they
  // cleared the 30-day OHLCV pre-filter in analyzer.ts). The revision values
  // will be null for ~30 days after first coverage of a given ticker.
  const analystTargetMean   = safeNum(finData.targetMeanPrice);
  const analystTargetMedian = safeNum(finData.targetMedianPrice);
  const analystTargetHigh   = safeNum(finData.targetHighPrice);
  const analystTargetLow    = safeNum(finData.targetLowPrice);
  const analystOpinionCount = safeNum(finData.numberOfAnalystOpinions) ?? 0;
  const recommendationMean  = safeNum(finData.recommendationMean);
  const epsEstCurrQ = safeNum(trend0?.earningsEstimate?.avg);
  const epsEstNextQ = safeNum(trend1?.earningsEstimate?.avg);

  let targetMeanRevision30d:   number | null = null;
  let epsEstRevision30dCurrQ:  number | null = null;
  let epsEstRevision30dNextQ:  number | null = null;

  try {
    const [prevRows] = await executeRawQuery(
      `SELECT target_mean, eps_est_curr_q, eps_est_next_q
         FROM analyst_estimate_history
        WHERE symbol = ?
          AND snapshot_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 35 DAY)
                                AND DATE_SUB(CURDATE(), INTERVAL 25 DAY)
        ORDER BY snapshot_date DESC LIMIT 1`,
      [ticker]
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

    await executeRawQuery(
      `INSERT INTO analyst_estimate_history
         (symbol, snapshot_date, target_mean, target_median, target_high, target_low,
          eps_est_curr_q, eps_est_next_q, recommendation_mean, analyst_opinion_count)
       VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         target_mean           = VALUES(target_mean),
         target_median         = VALUES(target_median),
         target_high           = VALUES(target_high),
         target_low            = VALUES(target_low),
         eps_est_curr_q        = VALUES(eps_est_curr_q),
         eps_est_next_q        = VALUES(eps_est_next_q),
         recommendation_mean   = VALUES(recommendation_mean),
         analyst_opinion_count = VALUES(analyst_opinion_count)`,
      [
        ticker,
        analystTargetMean, analystTargetMedian, analystTargetHigh, analystTargetLow,
        epsEstCurrQ, epsEstNextQ,
        recommendationMean, analystOpinionCount,
      ]
    );
  } catch (err: any) {
    logger.warn(`analyst_estimate_history r/w failed for ${ticker}`, { error: err });
  }

  // ── Phase 3: earnings module — historicalEarnings for beat streak ─────────
  let historicalEarnings: any[] = [];
  try {
    const earningsData = (summary as any).earnings;
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
      const parse = (d: string) => { const m = d.match(/(\d)Q(\d{4})/); return m ? parseInt(m[2]) * 10 + parseInt(m[1]) : 0; };
      return parse(b.date) - parse(a.date);
    });
  } catch (err) {
    logger.warn(`Failed to extract historicalEarnings for ${ticker}`, { error: err });
  }

  // ── featureMetrics payload ────────────────────────────────────────────────
  const featureMetrics = {
    // Earnings dates (Phase 1)
    lastEarningsDate,
    // EPS revision velocity (Phase 2)
    epsRevision7d_0Q,
    epsRevision7d_1Q,
    epsRevisionsUp7d,
    epsRevisionsDown7d,
    revenueEstGrowth_0Q,
    revenueEstGrowth_1Q,
    // Rating velocity (Phase 2)
    upgradeScore7d,
    upgradeScore30d,
    upgradeScore90d,
    ratingUp30d:   rc30.up,
    ratingDown30d: rc30.down,
    ratingUp90d:   rc90.up,
    ratingDown90d: rc90.down,
    // Analyst estimate revisions (Phase 4 — null until ~30 days of history)
    targetMeanRevision30d,
    epsEstRevision30dCurrQ,
    epsEstRevision30dNextQ,
    asOf: new Date().toISOString().slice(0, 10),
  };

  return {
    ticker,
    historicalData,
    recommendationKey: finData.recommendationKey ?? undefined,
    stockMetrics: {
      regularMarketPrice: price.regularMarketPrice,
      peRatio:            detail.trailingPE || price.trailingPE,
      pbRatio:            keyStats.priceToBook || detail.priceToBook,
      marketCap:          price.marketCap || detail.marketCap,
      revenueGrowth:      finData.revenueGrowth,
      earningsGrowth:     finData.earningsGrowth,
      recommendationMean: finData.recommendationMean ?? undefined,
      analystOpinionCount: finData.numberOfAnalystOpinions ?? undefined,
      sector:             profile.sector || 'Unknown',
      // Phase 1: earnings date proximity features
      nextEarningsDate,
      lastEarningsDate,
    },
    macroData: {
      worldBank: wbData ? { indicators: wbData.macro?.indicators, asOf: wbData.asOf } : null,
    },
    optionsData:        optionsRes || { available: false },
    featureMetrics,
    historicalEarnings,
    dataQuality: { historyDays: historicalData.length, shortHistory },
  };
}

export function runPredictionInternal(ticker: string, payload: any, outlook: string, opts: { skipNarrator?: boolean } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const tempFile = join(tmpdir(), `tf_sync_input_${randomUUID()}.json`);
    try {
      writeFileSync(tempFile, JSON.stringify(payload));
      const useLegacyModel = process.env.USE_LEGACY_PREDICTION_MODEL === 'true';
      const scriptName = useLegacyModel
        ? 'scripts/predict_weighted_analysis_baseline.py'
        : 'scripts/predict_weighted_analysis.py';
      const spawnEnv = opts.skipNarrator
        ? { ...process.env, OLLAMA_ENABLED: 'false' }
        : process.env;
      const python = spawn(getPythonExecutable(), [scriptName, ticker, '--input_file', tempFile, '--outlook', outlook], { env: spawnEnv });
      let stdout = '', stderr = '';
      python.stdout.on('data', d => { stdout += d; });
      python.stderr.on('data', d => { stderr += d; });
      python.on('close', code => {
        try { unlinkSync(tempFile); } catch {}
        if (code !== 0) return reject(new Error(`Exit ${code}: ${stderr}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid JSON output from python')); }
      });
    } catch (err) {
      try { unlinkSync(tempFile); } catch {}
      reject(err);
    }
  });
}

export function runFallbackPrediction(ticker: string, payload: any, outlook: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tempFile = join(tmpdir(), `tf_fallback_input_${randomUUID()}.json`);
    try {
      writeFileSync(tempFile, JSON.stringify(payload));
      const python = spawn(getPythonExecutable(), [
        'scripts/predict_fallback.py', ticker,
        '--input_file', tempFile,
        '--outlook', outlook,
      ], { env: { ...process.env, OLLAMA_ENABLED: 'false' } });
      let stdout = '', stderr = '';
      python.stdout.on('data', d => { stdout += d; });
      python.stderr.on('data', d => { stderr += d; });
      python.on('close', code => {
        try { unlinkSync(tempFile); } catch {}
        if (code !== 0) return reject(new Error(`Fallback exit ${code}: ${stderr}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Fallback: invalid JSON')); }
      });
    } catch (err) {
      try { unlinkSync(tempFile); } catch {}
      reject(err);
    }
  });
}
