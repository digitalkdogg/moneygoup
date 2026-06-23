/**
 * One-off: time predict_weighted_analysis.py for a single ticker × 4 timeframes.
 * Mirrors what analyzer.ts does per ranker survivor in the deepmoney pass.
 *
 * Run: npx jiti scripts/time_one_prediction.ts [TICKER]
 *
 * Inlines a minimal payload builder so this script doesn't depend on @/ aliases.
 */
import YahooFinance from 'yahoo-finance2';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

function getPython(): string {
  const venv = join(process.cwd(), 'venv', 'bin', 'python3');
  return existsSync(venv) ? venv : 'python3';
}

async function buildPayload(ticker: string) {
  const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [chart, summary] = await Promise.all([
    yf.chart(ticker, { period1: fiveYearsAgo, period2: yesterday, interval: '1d' }).catch(() => ({ quotes: [] })),
    yf.quoteSummary(ticker, {
      modules: ['price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile', 'calendarEvents']
    }).catch(() => ({}) as any),
  ]);

  const historicalData = ((chart as any).quotes || []).map((r: any) => ({
    date: new Date(r.date).toISOString().slice(0, 10),
    open: r.open ?? 0,
    high: r.high ?? 0,
    low: r.low ?? 0,
    close: r.adjClose ?? r.close ?? 0,
    volume: r.volume ?? 0,
  }));

  if (historicalData.length < 365) {
    throw new Error(`Insufficient OHLCV for ${ticker}: ${historicalData.length} rows`);
  }

  const price = (summary as any).price || {};
  const detail = (summary as any).summaryDetail || {};
  const finData = (summary as any).financialData || {};
  const keyStats = (summary as any).defaultKeyStatistics || {};
  const profile = (summary as any).assetProfile || {};

  return {
    ticker,
    historicalData,
    stockMetrics: {
      regularMarketPrice: price.regularMarketPrice,
      peRatio: detail.trailingPE || price.trailingPE,
      pbRatio: keyStats.priceToBook || detail.priceToBook,
      marketCap: price.marketCap || detail.marketCap,
      revenueGrowth: finData.revenueGrowth,
      earningsGrowth: finData.earningsGrowth,
      sector: profile.sector || 'Unknown',
    },
    macroData: { worldBank: null },
    optionsData: { available: false },
    dataQuality: { historyDays: historicalData.length },
  };
}

function runPrediction(ticker: string, payload: any, outlook: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tempFile = join(tmpdir(), `tf_sync_input_${randomUUID()}.json`);
    try {
      writeFileSync(tempFile, JSON.stringify(payload));
      const python = spawn(getPython(), ['scripts/predict_weighted_analysis.py', ticker, '--input_file', tempFile, '--outlook', outlook]);
      let stdout = '', stderr = '';
      python.stdout.on('data', d => { stdout += d; });
      python.stderr.on('data', d => { stderr += d; });
      python.on('close', code => {
        try { unlinkSync(tempFile); } catch {}
        if (code !== 0) return reject(new Error(`Exit ${code}: ${stderr.slice(0, 400)}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid JSON: ${stdout.slice(0, 200)}`)); }
      });
    } catch (err) {
      try { unlinkSync(tempFile); } catch {}
      reject(err);
    }
  });
}

async function main() {
  const ticker = process.argv[2] || 'AAPL';
  const timeframes = ['1_week', '1_month', '6_month', '1_year'] as const;

  console.log(`Timing predict_weighted_analysis.py for ${ticker}...`);

  const tFetchStart = Date.now();
  const payload = await buildPayload(ticker);
  const fetchMs = Date.now() - tFetchStart;
  console.log(`  payload fetch (Yahoo summary + 5y OHLCV): ${(fetchMs / 1000).toFixed(2)}s  [${payload.historicalData.length} OHLCV rows]`);

  const perTf: Record<string, number> = {};
  const tAllStart = Date.now();
  for (const tf of timeframes) {
    const tStart = Date.now();
    try {
      const result = await runPrediction(ticker, payload, tf);
      const ms = Date.now() - tStart;
      perTf[tf] = ms;
      const pct = result?.predicted_change_pct;
      const conf = result?.confidence_score;
      console.log(`  ${tf.padEnd(8)} -> ${(ms / 1000).toFixed(2)}s  (predicted_change_pct=${pct}, confidence=${conf})`);
    } catch (e: any) {
      console.error(`  ${tf} FAILED: ${e?.message || e}`);
    }
  }
  const totalMs = Date.now() - tAllStart;

  console.log(`\nTotal time for 1 ticker × 4 timeframes: ${(totalMs / 1000).toFixed(2)}s`);

  // Extrapolate
  const perTickerSec = totalMs / 1000;
  const totalCount = 275;
  for (const concurrent of [1, 3, 5]) {
    const wallSec = (totalCount * perTickerSec) / concurrent;
    console.log(`  ${totalCount} sector leaders @ BATCH_SIZE=${concurrent}: ~${(wallSec / 60).toFixed(0)} min  (~${(wallSec / 3600).toFixed(2)} hr)`);
  }
  console.log(`\nFull-cold cost. With a 7-day freshness gate, ongoing nightly cost is ~5-10% of this.`);
}
main().catch(e => { console.error(e); process.exit(1); });
