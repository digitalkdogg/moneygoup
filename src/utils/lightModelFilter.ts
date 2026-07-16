/**
 * Light Model Filter — CS-model pre-filter between ranker keep-cut and
 * full Monte Carlo in the deepmoney analyzer.
 *
 * Spawns predict_light.py ONCE per run with all ranker survivors batched
 * in a single subprocess. predict_light.py loads long_term_cs_v2.pkl,
 * builds feat_df for each ticker using the same predict_core machinery
 * as the full pipeline, runs inference, and emits a predicted 6m % change.
 *
 * Tickers where the CS model predicts negative 6m return are filtered out
 * before Phase 4 (full Monte Carlo + GPS-Full), which is the expensive step.
 *
 * Fail-open: if the subprocess fails for any reason, every candidate is
 * treated as passed so the pipeline stays operational. Errors surface at
 * warn level in the logs.
 */
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@/utils/logger';
import { getPythonExecutable } from '@/utils/pythonPath';
import type { EnrichedStock } from '@/app/api/prediction/deepmoney/analyzer';

const logger = createLogger('utils/lightModelFilter');

export interface LightModelResult {
    passed:            boolean;
    predictedChange6m: number;
    error:             string | null;
}

export type LightModelResultMap = Map<string, LightModelResult>;

/**
 * Run the CS light-model filter on a batch of ranker survivors.
 *
 * @param candidates  Stocks that passed the ranker keep-cut. Override-lane
 *                    stocks (analyst, trending, sector-leaders) should NOT
 *                    be included — they bypass this filter the same way they
 *                    bypass the ranker keep-cut.
 * @param payloads    OHLCV + fundamentals payloads already fetched in Phase 1.
 * @param threshold   Minimum predicted 6m % change to pass (default 0 = any
 *                    positive return). Increase to tighten the gate.
 * @returns Map of ticker → { passed, predictedChange6m, error }.
 *          Tickers not in the map (payload missing etc.) are treated as passed.
 */
export async function runLightModelFilter(
    candidates: EnrichedStock[],
    payloads:   Map<string, any>,
    threshold = 0.0,
): Promise<LightModelResultMap> {
    if (candidates.length === 0) return new Map();

    const batchCandidates = candidates
        .map(s => {
            const payload = payloads.get(s.ticker);
            if (!payload) return null;
            return { ticker: s.ticker, payload };
        })
        .filter((c): c is { ticker: string; payload: any } => c !== null);

    if (batchCandidates.length === 0) return new Map();

    const inputPayload = { threshold, candidates: batchCandidates };
    const tempFile = join(tmpdir(), `light_model_${randomUUID()}.json`);

    try {
        writeFileSync(tempFile, JSON.stringify(inputPayload));
        const raw    = await runLightSubprocess(tempFile);
        const parsed = JSON.parse(raw);

        const map: LightModelResultMap = new Map();
        for (const [ticker, info] of Object.entries(parsed.results ?? {}) as [string, any][]) {
            map.set(ticker, {
                passed:            Boolean(info.passed),
                predictedChange6m: typeof info.predicted_change_pct_6m === 'number'
                    ? info.predicted_change_pct_6m
                    : 0,
                error: info.error ?? null,
            });
        }

        const { passed_count = 0, filtered_count = 0 } = parsed;
        logger.info(
            `Light model: ${passed_count} passed, ${filtered_count} filtered ` +
            `(threshold=${threshold}%)`
        );

        // Per-ticker predictions — sorted so passing/filtering pairs read
        // together and the log line for any single ticker is greppable.
        const perTicker = [...map.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ticker, r]) =>
                `${ticker}=${r.predictedChange6m.toFixed(2)}%${r.passed ? '' : ' [FILTERED]'}`
            )
            .join(', ');
        logger.info(`Light model per-ticker 6m predictions: ${perTicker}`);
        return map;
    } catch (err) {
        logger.warn('Light model filter failed — treating all candidates as passed', {
            error: String(err),
        });
        const map: LightModelResultMap = new Map();
        for (const s of candidates) {
            map.set(s.ticker, { passed: true, predictedChange6m: 0, error: 'subprocess_failed' });
        }
        return map;
    } finally {
        try { unlinkSync(tempFile); } catch {}
    }
}

function runLightSubprocess(inputFile: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const python = spawn(
            getPythonExecutable(),
            ['scripts/predict_light.py', '--input-file', inputFile],
        );
        let stdout = '';
        let stderr = '';
        python.stdout.on('data', (d: Buffer) => { stdout += d; });
        python.stderr.on('data', (d: Buffer) => { stderr += d; });
        python.on('close', (code: number | null) => {
            if (stderr.length) {
                logger.info('predict_light.py stderr', { stderr: stderr.slice(0, 800) });
            }
            if (code !== 0) {
                return reject(new Error(
                    `predict_light.py exit ${code}: ${stderr.slice(0, 300)}`
                ));
            }
            resolve(stdout);
        });
    });
}
