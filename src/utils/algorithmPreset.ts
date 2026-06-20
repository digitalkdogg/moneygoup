/**
 * DEEPMONEY_ALGORITHM (1..10) is the single knob that drives pipeline
 * aggressiveness end-to-end. This module is the only place that reads the
 * env var and the only place that loads models/algorithm_presets.json.
 *
 * route.ts resolves the level once per request and echoes the preset back
 * in `meta.algorithm`; deepmoney_sync.py consumes it from that meta block
 * rather than re-reading the JSON file, so the file → preset mapping never
 * drifts between TS and Python.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@/utils/logger';

const logger = createLogger('utils/algorithmPreset');

export interface AlgorithmPreset {
    /** Fraction of the ranked collection that survives the LightGBM filter. */
    rankerKeepPct: number;
    /** Minimum MLP confidence score for a stock to push to a user dashboard. */
    mlpConfidenceFloor: number;
    /** Minimum confidence for high-beta (>2.5) stocks specifically. */
    volGateFloor: number;
    /** Minimum current-month analyst strongBuy count required for a stock to
     *  bypass the LightGBM ranker filter. Decreases as the level rises so
     *  higher DEEPMONEY_ALGORITHM values surface more analyst-consensus
     *  picks. Stocks routed via this lane still need positive predicted
     *  change to be surfaced (mlGate is bypassed, the > 0 floor is not). */
    analystStrongBuyThreshold: number;
}

export interface ResolvedAlgorithm extends AlgorithmPreset {
    level: number;
}

const DEFAULT_LEVEL = 5;

let cachedTable: Record<string, AlgorithmPreset> | null = null;

function loadTable(): Record<string, AlgorithmPreset> {
    if (cachedTable) return cachedTable;
    const path = join(process.cwd(), 'models', 'algorithm_presets.json');
    const raw = readFileSync(path, 'utf8');
    cachedTable = JSON.parse(raw) as Record<string, AlgorithmPreset>;
    return cachedTable;
}

/** Parse the DEEPMONEY_ALGORITHM env var as a float; clamp to [1,10]; default
 *  to 5. Fractional levels (e.g. 1.5, 3.7) are accepted and linearly
 *  interpolated by loadAlgorithmPreset against the discrete preset table. */
export function clampAlgorithmLevel(raw: string | undefined): number {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_LEVEL;
    const n = parseFloat(raw);
    if (Number.isNaN(n) || n < 1 || n > 10) {
        logger.warn(`Invalid DEEPMONEY_ALGORITHM='${raw}', defaulting to ${DEFAULT_LEVEL}`);
        return DEFAULT_LEVEL;
    }
    return n;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Return the preset for the given level. Integer levels return the table
 *  entry directly; fractional levels are linearly interpolated between the
 *  two adjacent integer entries. analystStrongBuyThreshold is rounded to the
 *  nearest integer at the end since strongBuy counts from Yahoo are integers. */
export function loadAlgorithmPreset(level: number): AlgorithmPreset {
    const table = loadTable();
    const lowerKey = Math.floor(level);
    const upperKey = Math.ceil(level);
    const lowerEntry = table[String(lowerKey)] ?? table[String(DEFAULT_LEVEL)];
    if (lowerKey === upperKey) return lowerEntry;
    const upperEntry = table[String(upperKey)] ?? lowerEntry;
    const t = level - lowerKey; // 0..1 interpolation factor
    return {
        rankerKeepPct:             lerp(lowerEntry.rankerKeepPct,             upperEntry.rankerKeepPct,             t),
        mlpConfidenceFloor:        lerp(lowerEntry.mlpConfidenceFloor,        upperEntry.mlpConfidenceFloor,        t),
        volGateFloor:              lerp(lowerEntry.volGateFloor,              upperEntry.volGateFloor,              t),
        analystStrongBuyThreshold: Math.round(lerp(lowerEntry.analystStrongBuyThreshold, upperEntry.analystStrongBuyThreshold, t)),
    };
}

/** One-shot: resolve env var → level + preset, suitable for echoing into meta. */
export function resolveAlgorithm(raw: string | undefined): ResolvedAlgorithm {
    const level = clampAlgorithmLevel(raw);
    return { level, ...loadAlgorithmPreset(level) };
}
