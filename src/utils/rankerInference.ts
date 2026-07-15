/**
 * Bridge between the TS analyzer and the Python ranker (scripts/score_ranker.py).
 *
 * Two responsibilities:
 *   1. Fetch the macro/sector-ETF time-series the ranker needs ONCE per run,
 *      not per ticker. ~22 series total (10 macro + 12 sector ETFs).
 *      Cached in-memory with a short TTL so repeated runs in the same JVM
 *      don't re-pull from Yahoo.
 *   2. Build the batch input payload for score_ranker.py, spawn the Python
 *      subprocess, parse the JSON response back into a typed Map.
 */
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import YahooFinance from 'yahoo-finance2';
import { createLogger } from '@/utils/logger';
import { getPythonExecutable } from '@/utils/pythonPath';

// Minimal subset of EnrichedStock that scoreWithRanker needs. Declared here
// rather than imported to avoid the circular import (analyzer.ts imports
// from this file).
type RankerInputStock = { ticker: string; sector?: string };

const logger = createLogger('utils/rankerInference');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ─── Sector → ETF mapping (mirrors src/app/api/stock_data/[ticker]/data/route.ts) ──
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

// Macro symbols the ranker expects. Keys match what scripts/score_ranker.py
// looks for in macroData.
const MACRO_SYMBOLS = {
    vix:          '^VIX',
    treasury10y:  '^TNX',
    treasury3m:   '^IRX',
    spy:          'SPY',
    hyg:          'HYG',
    lqd:          'LQD',
    dxy:          'DX-Y.NYB',
    wti:          'CL=F',
    copper:       'HG=F',
    wheat:        'ZW=F',
} as const;

type MacroSeries = { date: string; close: number }[];
export interface SharedMacro {
    vix: MacroSeries;
    treasury10y: MacroSeries;
    treasury3m: MacroSeries;
    spy: MacroSeries;
    hyg: MacroSeries;
    lqd: MacroSeries;
    dxy: MacroSeries;
    wti: MacroSeries;
    copper: MacroSeries;
    wheat: MacroSeries;
    sectorEtfs: Record<string, MacroSeries>;  // ticker → series, e.g. 'XLK' → [...]
}

// Simple in-memory cache (30-min TTL). The same TTL pattern as macroCache
// inside the existing stock_data route.
const sharedMacroCache: { value?: SharedMacro; fetchedAt?: number } = {};
const SHARED_MACRO_TTL_MS = 30 * 60 * 1000;

// Per-series timeout — yahoo-finance2's chart() doesn't accept an AbortSignal,
// so we race against a timer. Symbols like DX-Y.NYB occasionally hang for
// tens of seconds; without this, all 22 parallel calls block on the slowest.
const MACRO_SERIES_TIMEOUT_MS = 10_000;

async function fetchOneSeries(sym: string): Promise<MacroSeries> {
    // History trimmed 5y → 3y. The ranker's rolling features max out at ~250
    // trading days; anything beyond ~2y is just JSON parsing overhead. Cuts
    // per-series payload ~40%.
    const threeYearsAgo = new Date(Date.now() - 3 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const fetchPromise = yahooFinance.chart(sym, { period1: threeYearsAgo, period2: yesterday, interval: '1d' });
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${MACRO_SERIES_TIMEOUT_MS}ms`)), MACRO_SERIES_TIMEOUT_MS),
    );

    try {
        const chartResult = await Promise.race([fetchPromise, timeoutPromise]);
        const rows = chartResult.quotes || [];
        return rows
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
            .map(r => ({
                date:  new Date(r.date).toISOString().slice(0, 10),
                close: (r as any).adjclose ?? (r as any).close ?? 0,
            }))
            .filter(r => r.close > 0);
    } catch (err) {
        logger.warn(`Macro series fetch failed for ${sym}`, { error: String(err) });
        return [];
    }
}

/**
 * Fetch all macro + sector-ETF series the ranker needs. Cached for 30 min so
 * back-to-back deepmoney_sync runs don't re-pull. Throws if the SPY series
 * fails — the ranker can't function without a trading calendar baseline.
 */
export async function fetchRankerSharedMacro(): Promise<SharedMacro> {
    const now = Date.now();
    if (sharedMacroCache.value && sharedMacroCache.fetchedAt && (now - sharedMacroCache.fetchedAt) < SHARED_MACRO_TTL_MS) {
        return sharedMacroCache.value;
    }

    const macroEntries = Object.entries(MACRO_SYMBOLS);
    const sectorTickers = Array.from(new Set(Object.values(SECTOR_ETF)));

    const macroResults = await Promise.all(macroEntries.map(([, sym]) => fetchOneSeries(sym)));
    const sectorResults = await Promise.all(sectorTickers.map(s => fetchOneSeries(s)));

    const macro: Record<string, MacroSeries> = {};
    macroEntries.forEach(([key], i) => { macro[key] = macroResults[i]; });

    const sectorEtfs: Record<string, MacroSeries> = {};
    sectorTickers.forEach((t, i) => { sectorEtfs[t] = sectorResults[i]; });

    if (!macro.spy || macro.spy.length === 0) {
        throw new Error('Failed to fetch SPY macro series — ranker cannot run without trading-calendar baseline');
    }

    const result: SharedMacro = {
        vix:          macro.vix,
        treasury10y:  macro.treasury10y,
        treasury3m:   macro.treasury3m,
        spy:          macro.spy,
        hyg:          macro.hyg,
        lqd:          macro.lqd,
        dxy:          macro.dxy,
        wti:          macro.wti,
        copper:       macro.copper,
        wheat:        macro.wheat,
        sectorEtfs,
    };
    sharedMacroCache.value = result;
    sharedMacroCache.fetchedAt = now;
    return result;
}

export interface RankerScoreInfo {
    rankPct: number;       // 0..1 percentile within today's batch
    rawScore: number;      // model's raw output, kept for debugging
    histVol30: number | null;
}
export type RankerScoreMap = Map<string, RankerScoreInfo>;

/**
 * Build the batch payload for score_ranker.py and parse its output. Returns
 * a map of ticker → {rankPct, rawScore, histVol30}. Tickers that the ranker
 * skipped (insufficient OHLCV history etc.) won't appear in the map — the
 * caller treats their absence as "no ranker score available."
 */
export async function scoreWithRanker(
    stocks: RankerInputStock[],
    payloads: Map<string, any>,
    sharedMacro: SharedMacro,
): Promise<RankerScoreMap> {
    // World Bank annual indicators — pluck from any payload that has them
    let worldBank: any = null;
    for (const s of stocks) {
        const p = payloads.get(s.ticker);
        if (p?.macroData?.worldBank) {
            worldBank = p.macroData.worldBank;
            break;
        }
    }

    const candidates = stocks
        .map(stock => {
            const payload = payloads.get(stock.ticker);
            if (!payload?.historicalData?.length) return null;
            const sectorEtf = SECTOR_ETF[stock.sector ?? ''] ?? 'SPY';
            return {
                ticker: stock.ticker,
                historicalData: payload.historicalData,
                // Pass shared macro per-candidate — score_ranker.py reads it from
                // each candidate's macroData block (same shape predict_weighted_analysis
                // expects, just only the fields the ranker uses).
                macroData: {
                    vix:          sharedMacro.vix,
                    treasury10y:  sharedMacro.treasury10y,
                    treasury3m:   sharedMacro.treasury3m,
                    spy:          sharedMacro.spy,
                    hyg:          sharedMacro.hyg,
                    lqd:          sharedMacro.lqd,
                    dxy:          sharedMacro.dxy,
                    wti:          sharedMacro.wti,
                    copper:       sharedMacro.copper,
                    wheat:        sharedMacro.wheat,
                    sectorEtf:    { ticker: sectorEtf, data: sharedMacro.sectorEtfs[sectorEtf] ?? [] },
                    worldBank,
                },
            };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) return new Map();

    const today = new Date().toISOString().slice(0, 10);
    const inputPayload = { snapshot_date: today, candidates };

    const result = await runRankerSubprocess(inputPayload);

    const map: RankerScoreMap = new Map();
    if (result?.scores) {
        for (const [ticker, info] of Object.entries(result.scores) as [string, any][]) {
            map.set(ticker, {
                rankPct: typeof info.rank_pct === 'number' ? info.rank_pct : 0,
                rawScore: typeof info.raw_score === 'number' ? info.raw_score : 0,
                histVol30: typeof info.hist_vol_30 === 'number' ? info.hist_vol_30 : null,
            });
        }
    }
    if (result?.skipped?.length) {
        logger.info(`Ranker skipped ${result.skipped.length} tickers (insufficient history)`);
    }
    return map;
}

function runRankerSubprocess(payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const tempFile = join(tmpdir(), `ranker_input_${randomUUID()}.json`);
        try {
            writeFileSync(tempFile, JSON.stringify(payload));
            const python = spawn(getPythonExecutable(), ['scripts/score_ranker.py', '--input-file', tempFile]);
            let stdout = '', stderr = '';
            python.stdout.on('data', d => { stdout += d; });
            python.stderr.on('data', d => { stderr += d; });
            python.on('close', code => {
                try { unlinkSync(tempFile); } catch {}
                if (code !== 0) return reject(new Error(`score_ranker.py exit ${code}: ${stderr}`));
                try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('Invalid JSON from score_ranker.py: ' + String(e))); }
            });
        } catch (err) {
            try { unlinkSync(tempFile); } catch {}
            reject(err);
        }
    });
}
