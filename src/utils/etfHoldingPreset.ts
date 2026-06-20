/**
 * ETF_HOLDING_ALGORITHM (1..10) is the single knob that drives how many ETF
 * holdings get discovered and surfaced end-to-end. This module is the only
 * place that reads the env var and the only place that loads
 * models/etf_holding_presets.json. Mirrors src/utils/algorithmPreset.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@/utils/logger';

const logger = createLogger('utils/etfHoldingPreset');

export interface EtfHoldingPreset {
    /** Minimum ETF GPS score required for an ETF to qualify for holdings extraction. */
    etfGpsThreshold: number;
    /** How many top-scoring qualifying ETFs to pull holdings from. */
    topNEtfs: number;
    /** Per-ETF holdings fetch cap and global post-dedup scoring cap. */
    maxTickers: number;
    /** Minimum GPS score for a holding to be surfaced. */
    gpsSurfaceValue: number;
    /** Minimum predicted 1-month change (%) for a holding to be surfaced. */
    minPredChangePct: number;
}

export interface ResolvedEtfHoldingAlgorithm extends EtfHoldingPreset {
    level: number;
}

const DEFAULT_LEVEL = 5;

let cachedTable: Record<string, EtfHoldingPreset> | null = null;

function loadTable(): Record<string, EtfHoldingPreset> {
    if (cachedTable) return cachedTable;
    const path = join(process.cwd(), 'models', 'etf_holding_presets.json');
    const raw = readFileSync(path, 'utf8');
    cachedTable = JSON.parse(raw) as Record<string, EtfHoldingPreset>;
    return cachedTable;
}

/** Parse the ETF_HOLDING_ALGORITHM env var as a float; clamp to [1,10];
 *  default to 5. Fractional levels (e.g. 1.5, 3.7) are accepted and linearly
 *  interpolated by loadEtfHoldingPreset against the discrete preset table. */
export function clampEtfHoldingLevel(raw: string | undefined): number {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_LEVEL;
    const n = parseFloat(raw);
    if (Number.isNaN(n) || n < 1 || n > 10) {
        logger.warn(`Invalid ETF_HOLDING_ALGORITHM='${raw}', defaulting to ${DEFAULT_LEVEL}`);
        return DEFAULT_LEVEL;
    }
    return n;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Return the preset for the given level. Integer levels return the table
 *  entry directly; fractional levels are linearly interpolated between the
 *  two adjacent integer entries. topNEtfs and maxTickers are rounded to the
 *  nearest integer at the end since they're counts. */
export function loadEtfHoldingPreset(level: number): EtfHoldingPreset {
    const table = loadTable();
    const lowerKey = Math.floor(level);
    const upperKey = Math.ceil(level);
    const lowerEntry = table[String(lowerKey)] ?? table[String(DEFAULT_LEVEL)];
    if (lowerKey === upperKey) return lowerEntry;
    const upperEntry = table[String(upperKey)] ?? lowerEntry;
    const t = level - lowerKey; // 0..1 interpolation factor
    return {
        etfGpsThreshold:  lerp(lowerEntry.etfGpsThreshold,  upperEntry.etfGpsThreshold,  t),
        topNEtfs:         Math.round(lerp(lowerEntry.topNEtfs,         upperEntry.topNEtfs,         t)),
        maxTickers:       Math.round(lerp(lowerEntry.maxTickers,       upperEntry.maxTickers,       t)),
        gpsSurfaceValue:  lerp(lowerEntry.gpsSurfaceValue,  upperEntry.gpsSurfaceValue,  t),
        minPredChangePct: lerp(lowerEntry.minPredChangePct, upperEntry.minPredChangePct, t),
    };
}

/** One-shot: resolve env var → level + preset. */
export function resolveEtfHoldingAlgorithm(raw: string | undefined): ResolvedEtfHoldingAlgorithm {
    const level = clampEtfHoldingLevel(raw);
    return { level, ...loadEtfHoldingPreset(level) };
}
