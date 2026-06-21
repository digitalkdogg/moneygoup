/**
 * ETF_HOLDING_ALGORITHM (1..10, float) is the single knob driving ETF
 * holdings surfacing aggressiveness end-to-end. Structurally identical to
 * algorithmPreset.ts: parse env var → clamp → interpolate against the table
 * in models/etf_holding_presets.json. Loaded once per process via this
 * module so all three call sites (etfDiscovery.ts, etfHoldings.ts,
 * holdings/route.ts) resolve the same preset.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@/utils/logger';

const logger = createLogger('utils/etfHoldingPreset');

export interface EtfHoldingPreset {
    /** Minimum ETF GPS score for an ETF to qualify as "hot" — replaces
     *  the hardcoded ETF_GPS_THRESHOLD constant in etfDiscovery.ts. */
    etfGpsThreshold: number;
    /** Top-N qualifying ETFs to keep after sorting by score — replaces
     *  the hardcoded .slice(0, 10) in etfDiscovery.ts. */
    topNEtfs: number;
    /** Per-ETF holdings fetch cap AND post-dedup scoring cap — replaces
     *  the ETF_HOLDING_MAX_TICKERS env var. */
    maxTickers: number;
    /** Minimum holding GPS score to mark as surfaced — replaces the
     *  ETF_HOLDING_GPS_SURFACE_VALUE env var. */
    gpsSurfaceValue: number;
    /** Minimum predicted-change % for a holding to surface — replaces
     *  the ETF_HOLDING_MIN_PRED_CHANGE env var. */
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

/** Parse ETF_HOLDING_ALGORITHM as a float; clamp to [1,10]; default to 5.
 *  Fractional levels are accepted and interpolated by loadEtfHoldingPreset. */
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

/** Return the preset for the given level. Integer levels read the table row
 *  directly; fractional levels are linearly interpolated between the two
 *  adjacent integer rows. topNEtfs and maxTickers are rounded to integers
 *  since they're counts; the threshold fields stay as floats. */
export function loadEtfHoldingPreset(level: number): EtfHoldingPreset {
    const table = loadTable();
    const lowerKey = Math.floor(level);
    const upperKey = Math.ceil(level);
    const lowerEntry = table[String(lowerKey)] ?? table[String(DEFAULT_LEVEL)];
    if (lowerKey === upperKey) return lowerEntry;
    const upperEntry = table[String(upperKey)] ?? lowerEntry;
    const t = level - lowerKey;
    return {
        etfGpsThreshold:  lerp(lowerEntry.etfGpsThreshold,  upperEntry.etfGpsThreshold,  t),
        topNEtfs:         Math.round(lerp(lowerEntry.topNEtfs,   upperEntry.topNEtfs,    t)),
        maxTickers:       Math.round(lerp(lowerEntry.maxTickers, upperEntry.maxTickers,  t)),
        gpsSurfaceValue:  lerp(lowerEntry.gpsSurfaceValue,  upperEntry.gpsSurfaceValue,  t),
        minPredChangePct: lerp(lowerEntry.minPredChangePct, upperEntry.minPredChangePct, t),
    };
}

/** One-shot: resolve env var → level + preset, suitable for passing into
 *  sharedContext or echoing into a meta block. */
export function resolveEtfHoldingAlgorithm(raw: string | undefined): ResolvedEtfHoldingAlgorithm {
    const level = clampEtfHoldingLevel(raw);
    return { level, ...loadEtfHoldingPreset(level) };
}
