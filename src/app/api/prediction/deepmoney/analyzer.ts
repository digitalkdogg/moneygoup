import { createLogger } from '@/utils/logger';
import { getStockDataForPrediction, runPredictionInternal } from '@/utils/stockDataHelper';
import { calculateGpsScore, calculateGpsLight } from '@/utils/gps';
import { fetchRankerSharedMacro, scoreWithRanker, type RankerScoreMap } from '@/utils/rankerInference';

const logger = createLogger('api/prediction/deepmoney/analyzer');

/**
 * Interface representing a stock with its enriched metrics.
 */
export interface EnrichedStock {
    ticker: string;
    name: string;
    price?: number | null;
    changePercent?: number | null;
    pe?: number | null;
    pb?: number | null;
    debtToEquity?: number | null;
    roe?: number | null;
    beta?: number | null;
    dividendYield?: number | null;
    marketCap?: number | null;
    revenueGrowth?: number | null;
    earningsGrowth?: number | null;
    grossMargins?: number | null;
    researchDevelopment?: number | null;
    totalRevenue?: number | null;
    fiftyTwoWeekChange?: number | null;
    analystUpside?: number | null;
    /** Count of analyst opinions in the strongBuy bucket for the current month
     *  (recommendationTrend "0m" period). Drives the analyst-consensus override
     *  gate in analyzeStocks. Undefined when Yahoo has no trend data. */
    analystStrongBuy?: number | null;
    sma20?: number | null;
    sma50?: number | null;
    rsi?: number | null;
    tradingSignal?: string;
    tradingSignalScore?: number;
    recommendationKey?: string | null;
    signalStrength?: number;
    historyRows?: number;
    error?: string;
    prediction_1m?: number;
    gps_score?: number;
    classification?: string;
    sector?: string;
    prediction_input?: any;
    /** Why this stock made the cut. 'v2_engine' = passed the standard mlGate.
     *  'analyst_consensus' = positive prediction but below mlGate, surfaced
     *  by analyst strongBuy override. */
    discovery_source?: 'v2_engine' | 'analyst_consensus';

    /** Path-A additions (Step 3). gps_score_type tells consumers whether
     *  gps_score came from the cheap Tier-1 composite ('light') or the
     *  Monte-Carlo Tier-2 path ('full'). ranker_score is the model's
     *  percentile rank within today's universe, 0..1. hist_vol_30 is the
     *  annualized 30-day realized vol used by the GPS-Light uncertainty
     *  proxy — exposed so downstream consumers can audit the score. */
    gps_score_type?: 'light' | 'full';
    ranker_score?: number | null;
    hist_vol_30?: number | null;
}

/** Options that drive how the analyzer runs the ML and gates the results. */
export interface AnalyzeOptions {
    /** outlook passed to predict_weighted_analysis.py — '1_week' / '1_month' / '6_month' / '1_year'. */
    outlook?: '1_week' | '1_month' | '6_month' | '1_year';
    /** Minimum positive predicted change % required to surface (ML Validation Gate). */
    mlGate?: number;
    /** Minimum analyst strongBuy count to surface a stock whose prediction is
     *  positive but below mlGate. Bypasses only the mlGate — the > 0 floor
     *  still applies. Default 3 (DEEPMONEY_ANALYST_THRESHOLD). */
    analystThreshold?: number;
}

const BATCH_SIZE = 3;

/**
 * Analyzes and filters a list of enriched stocks.
 *
 * Path-A flow (when DEEPMONEY_USE_RANKER_GATE=true):
 *   1. Pre-filter (tradingSignalScore >= 0, historyRows >= 100).
 *   2. Fetch OHLCV payloads for ALL pre-filtered stocks.
 *   3. Score every stock with the LightGBM ranker in one batch.
 *   4. Compute GPS-Light for everyone; sort desc; promote top-N (DEEPMONEY_TIER2_TOPK).
 *   5. Run Monte Carlo + full GPS only on the promoted top-N.
 *   6. Light-tier stocks (the rest) land in `outLightTier` if provided —
 *      they have ranker_score, hist_vol_30, gps_score (light), gps_score_type='light'.
 *
 * Without the env flag, behavior matches the legacy single-pass flow exactly:
 * fetch + Monte Carlo + GPS-Full for every pre-filtered stock. The feature
 * flag is the rollback switch.
 *
 * Return value: same as before — only the surfaced stocks (passing mlGate ||
 * analystOverride), now decorated with gps_score_type='full', ranker_score
 * (when computed), and hist_vol_30. Callers that ignore the new fields work
 * unchanged.
 */
export async function analyzeStocks(
    stocks: EnrichedStock[],
    sharedContext?: { wbData?: any, marketIndices?: any },
    options: AnalyzeOptions = {},
    outLightTier?: EnrichedStock[],
): Promise<EnrichedStock[]> {
    const outlook          = options.outlook          ?? '1_month';
    const mlGate           = options.mlGate           ?? 1.5;
    const analystThreshold = options.analystThreshold ?? 3;

    const useRankerGate = process.env.DEEPMONEY_USE_RANKER_GATE === 'true';
    const tier2TopK     = parseInt(process.env.DEEPMONEY_TIER2_TOPK ?? '200', 10);

    // First filter: stocks that have a positive or neutral tradingSignalScore
    // This pre-filtering reduces the number of heavy prediction calls
    const initialFilteredStocks = stocks.filter(stock => {
        if (stock.error || stock.tradingSignalScore === undefined) {
            return false;
        }
        // User requested: skip if < 100 rows found in discovery enrichment pass
        if (stock.historyRows !== undefined && stock.historyRows < 100) {
            return false;
        }
        return stock.tradingSignalScore >= 0;
    });

    if (initialFilteredStocks.length === 0) {
        return [];
    }

    // ─── Phase 1 — fetch OHLCV payloads for every pre-filtered stock ───────
    // We need them all whether or not the ranker is on: legacy flow runs MC
    // on all of them; ranker flow needs OHLCV to compute its feature vector.
    const payloads = new Map<string, any>();
    for (let i = 0; i < initialFilteredStocks.length; i += BATCH_SIZE) {
        const batch = initialFilteredStocks.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (stock) => {
            try {
                const payload = await getStockDataForPrediction(stock.ticker, sharedContext?.wbData);
                payloads.set(stock.ticker, payload);
            } catch (err) {
                logger.error(`Payload fetch failed for ${stock.ticker}:`, { error: String(err) });
            }
        }));
    }

    // ─── Phase 2 — ranker scoring (cross-sectional, single batch) ──────────
    let rankerScores: RankerScoreMap = new Map();
    if (useRankerGate) {
        try {
            const sharedMacro = await fetchRankerSharedMacro();
            rankerScores = await scoreWithRanker(
                initialFilteredStocks,
                payloads,
                sharedMacro,
            );
            logger.info(`Ranker scored ${rankerScores.size}/${initialFilteredStocks.length} stocks`);
        } catch (err) {
            logger.error('Ranker scoring failed; falling back to legacy full-universe Monte Carlo', { error: String(err) });
            rankerScores = new Map();
        }
    }

    // ─── Phase 3 — GPS-Light + top-K selection ─────────────────────────────
    // If ranker succeeded, every pre-filtered stock gets a GPS-Light score
    // and only the top-K by Light score gets promoted to Monte Carlo.
    // If ranker failed or is disabled, every stock proceeds to MC (legacy).
    let tier2Tickers: Set<string>;

    if (rankerScores.size > 0) {
        const lightScored = initialFilteredStocks
            .map(stock => {
                const info = rankerScores.get(stock.ticker);
                if (!info) return null;
                const lightResult = calculateGpsLight(
                    {
                        analystUpside:     stock.analystUpside ?? 0,
                        revenueGrowthPct:  stock.revenueGrowth ?? 0,
                        earningsGrowthPct: stock.earningsGrowth ?? 0,
                        priceChange52w:    stock.fiftyTwoWeekChange ?? 0,
                        technicalScore:    stock.tradingSignalScore,
                        recommendationKey: stock.recommendationKey ?? undefined,
                    },
                    {
                        rankerScorePct: info.rankPct,
                        histVol30:      info.histVol30 ?? undefined,
                    }
                );
                return {
                    stock,
                    lightScore:     lightResult.score,
                    lightBreakdown: lightResult.breakdown,
                    rankerScore:    info.rankPct,
                    histVol30:      info.histVol30,
                };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);

        // Sort desc by Light score, promote top-K
        lightScored.sort((a, b) => b.lightScore - a.lightScore);
        const promoted = lightScored.slice(0, tier2TopK);
        const watchlist = lightScored.slice(tier2TopK);
        tier2Tickers = new Set(promoted.map(p => p.stock.ticker));

        // Push watchlist (Light-only) into outLightTier if caller provided one.
        // These stocks never get Monte Carlo, so gps_score IS the Light score.
        if (outLightTier) {
            for (const item of watchlist) {
                outLightTier.push({
                    ...item.stock,
                    gps_score:        item.lightScore,
                    gps_score_type:   'light',
                    ranker_score:     item.rankerScore,
                    hist_vol_30:      item.histVol30,
                    // gps_breakdown is on the stock object via `as any` to match
                    // existing pattern (it's not in EnrichedStock interface but
                    // downstream consumers read it).
                    ...({ gps_breakdown: item.lightBreakdown } as any),
                });
            }
        }
    } else {
        // Legacy / fallback: every pre-filtered stock gets Monte Carlo
        tier2Tickers = new Set(initialFilteredStocks.map(s => s.ticker));
    }

    // ─── Phase 4 — Monte Carlo + GPS-Full on promoted subset ───────────────
    const filteredStocks: EnrichedStock[] = [];
    const promotedStocks = initialFilteredStocks.filter(s => tier2Tickers.has(s.ticker));

    for (let i = 0; i < promotedStocks.length; i += BATCH_SIZE) {
        const batch = promotedStocks.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (stock) => {
            try {
                const payload = payloads.get(stock.ticker);
                if (!payload) {
                    logger.warn(`No payload cached for ${stock.ticker}, skipping MC`);
                    return;
                }

                // Run predictions for ALL four timeframes
                const predictions: Record<string, any> = {};
                const timeframes = ['1_week', '1_month', '6_month', '1_year'] as const;
                for (const tf of timeframes) {
                    const result = await runPredictionInternal(stock.ticker, payload, tf);
                    predictions[tf] = result;
                }

                // Use 1_month for the ML gate decision (consistent with prior behavior)
                const predictionResult = predictions['1_month'];
                const predictedChangePct = predictionResult?.predicted_change_pct;

                if (predictedChangePct !== undefined) {
                    stock.prediction_1m = predictedChangePct;
                    const passesMlGate    = predictedChangePct >= mlGate && predictedChangePct > 0;
                    const analystOverride = (stock.analystStrongBuy ?? 0) >= analystThreshold && predictedChangePct > 0;
                    if (passesMlGate || analystOverride) {

                        // --- GPS Score Calculation (v2.3) — unchanged ---
                        const gpsResult = calculateGpsScore(
                          {
                            analystUpside:     stock.analystUpside ?? 0,
                            revenueGrowthPct:  stock.revenueGrowth ?? 0,
                            earningsGrowthPct: stock.earningsGrowth ?? 0,
                            priceChange52w:    stock.fiftyTwoWeekChange ?? 0,
                            technicalScore:    stock.tradingSignalScore,
                            recommendationKey: stock.recommendationKey ?? undefined,
                          },
                          {
                            predictedChangePct1m: predictionResult.predicted_change_pct,
                            confidenceScore:      predictionResult.confidence_score,
                          }
                        );

                        stock.gps_score = gpsResult.score;
                        (stock as any).gps_breakdown = gpsResult.breakdown;
                        stock.gps_score_type = 'full';

                        // Attach ranker_score if it was computed in Phase 2 —
                        // gives Step 4 shadow validation paired data for free.
                        const rankerInfo = rankerScores.get(stock.ticker);
                        if (rankerInfo) {
                            stock.ranker_score = rankerInfo.rankPct;
                            stock.hist_vol_30  = rankerInfo.histVol30;
                        }

                        const rdSpendPct = (stock.researchDevelopment || 0) / (stock.totalRevenue || 1);
                        if ((stock.revenueGrowth || 0) >= 0.20 && (stock.grossMargins || 0) >= 0.50 && rdSpendPct >= 0.10) {
                            stock.classification = 'ai_tech_hyper_growth';
                        } else if ((stock.revenueGrowth || 0) >= 0.10 && (stock.fiftyTwoWeekChange || 0) >= 0.10) {
                            stock.classification = 'established_growth';
                        } else {
                            stock.classification = 'standard';
                        }

                        // Merge all four timeframe predictions into the input
                        stock.prediction_input = {
                            ...predictionResult,
                            predicted_price_1w: predictions['1_week']?.predicted_price,
                            predicted_price_1m: predictions['1_month']?.predicted_price,
                            predicted_price_6m: predictions['6_month']?.predicted_price,
                            predicted_price_1y: predictions['1_year']?.predicted_price,
                        };
                        stock.discovery_source = passesMlGate ? 'v2_engine' : 'analyst_consensus';
                        filteredStocks.push(stock);
                    }
                }
            } catch (err) {
                logger.error(`Error processing prediction for ${stock.ticker}:`, { error: String(err) });
            }
        }));
    }

    return filteredStocks;
}
