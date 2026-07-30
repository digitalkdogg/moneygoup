import YahooFinance from 'yahoo-finance2';
import { createLogger } from '@/utils/logger';
import { getPythonExecutable } from '@/utils/pythonPath';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const logger = createLogger('utils/stockDataHelper');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RETRIES = 3;

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

export async function getStockDataForPrediction(ticker: string, wbData?: any) {
  const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const today = yesterday.toISOString().slice(0, 10);

  // Parallel fetch of all components needed for the prediction payload
  const [chartResult, summary, optionsRes] = await Promise.all([
    yahooChartWithRetry(ticker, { period1: fiveYearsAgo, period2: today, interval: '1d' }),
    yahooFinance.quoteSummary(ticker, {
      modules: ['price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile', 'calendarEvents']
    }).catch(() => ({})),
    // Instead of internal fetch, we could just return null for options if not critical for sync
    Promise.resolve(null)
  ]);

  const historicalData = (chartResult.quotes || []).map((r: any) => ({
    date: new Date(r.date).toISOString().slice(0, 10),
    open: (r.open as number) ?? 0,
    high: (r.high as number) ?? 0,
    low: (r.low as number) ?? 0,
    close: (r.adjClose as number) ?? (r.close as number) ?? 0,
    volume: (r.volume as number) ?? 0,
  }));

  if (historicalData.length < 30) {
    throw new Error(`Insufficient data for ${ticker}: ${historicalData.length} rows, need >= 30.`);
  }
  const shortHistory = historicalData.length < 200;

  const price = (summary as any).price || {};

  const detail = (summary as any).summaryDetail || {};
  const finData = (summary as any).financialData || {};
  const keyStats = (summary as any).defaultKeyStatistics || {};
  const profile = (summary as any).assetProfile || {};

  return {
    ticker,
    historicalData,
    // Yahoo's `recommendationKey` ("buy" / "hold" / etc.) is the categorical
    // version of the analyst consensus; `recommendationMean` is the 1–5
    // numeric (1=Strong Buy, 5=Strong Sell). The Python predict scripts
    // prefer the key when present and fall back to the mean — see
    // predict_weighted_analysis.py:84 / _baseline.py:1242. Without these,
    // analyst_consensus.value stays at 0 for every single-ticker prediction.
    recommendationKey: finData.recommendationKey ?? undefined,
    stockMetrics: {
      regularMarketPrice: price.regularMarketPrice,
      peRatio: detail.trailingPE || price.trailingPE,
      pbRatio: keyStats.priceToBook || detail.priceToBook,
      marketCap: price.marketCap || detail.marketCap,
      revenueGrowth: finData.revenueGrowth,
      earningsGrowth: finData.earningsGrowth,
      recommendationMean: finData.recommendationMean ?? undefined,
      analystOpinionCount: finData.numberOfAnalystOpinions ?? undefined,
      sector: profile.sector || 'Unknown',
    },
    macroData: {
      worldBank: wbData ? { indicators: wbData.macro?.indicators, asOf: wbData.asOf } : null,
      // Add other macro series if needed, but keeping it minimal for speed
    },
    optionsData: optionsRes || { available: false },
    dataQuality: { historyDays: historicalData.length, shortHistory }
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
