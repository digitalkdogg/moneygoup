import { createLogger } from '@/utils/logger';
import { getStockDataForPrediction, runPredictionInternal } from '@/utils/stockDataHelper';
import { calculateGpsScore } from '@/utils/gps';
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
     *  (recommendationTrend "0m" period). Currently kept on the stock for
     *  visibility but no longer gates surfacing — the ranker is the sole
     *  filter. Slated to become a ranker training feature. */
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
    /** Why this stock made the cut. 'v2_engine' = passed the LightGBM ranker
     *  filter AND the mlGate. 'analyst_consensus' = bypassed the ranker via
     *  the analyst-strongBuy override lane (threshold scales with
     *  DEEPMONEY_ALGORITHM); these stocks still require positive predicted
     *  change, but skip the ranker keep-cut and the mlGate floor.
     *  'sector_leader' = a top-25 stock in one of the 11 canonical Yahoo
     *  sectors, injected to keep /search/industry/[sector] supplied with
     *  fresh GPS scores. Bypasses ranker keep-cut and mlGate entirely;
     *  always runs MC + GPS so the row is written regardless of outlook. */
    discovery_source?: 'v2_engine' | 'analyst_consensus' | 'sector_leader';

    /** gps_score_type is always 'full' now — every survivor of the ranker
     *  hard filter runs through Monte Carlo + GPS-Full. ranker_score is the
     *  model's percentile rank within today's universe (0..1). hist_vol_30
     *  is the annualized 30-day realized vol used during scoring — exposed
     *  so downstream consumers can audit the run. */
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
    /** Fraction of ranker-scored stocks (sorted by rank_pct desc) to keep.
     *  Driven by DEEPMONEY_ALGORITHM via models/algorithm_presets.json. */
    rankerKeepPct?: number;
    /** Minimum current-month analyst strongBuy count for a pre-filtered stock
     *  to bypass the ranker keep-cut. Also driven by DEEPMONEY_ALGORITHM —
     *  higher levels lower this threshold, surfacing more analyst picks. */
    analystStrongBuyThreshold?: number;
    /** Pre-filter floor on the technical signal score. Stocks with
     *  tradingSignalScore below this floor are dropped before the ranker.
     *  Defaults to 0 (preserves the historic >= 0 gate). */
    signalScoreFloor?: number;
    /** Tickers that should bypass the ranker keep-cut and always run MC + GPS,
     *  even if their predicted change is below mlGate. Caller is expected to
     *  pre-filter this set down to stocks whose existing stock_gps_scores row
     *  is missing or older than the configured freshness window. */
    sectorLeaderTickers?: Set<string>;
}

const BATCH_SIZE = 3;

/**
 * Analyzes and filters a list of enriched stocks. The LightGBM ranker is the
 * single hard filter — stocks that fall below the kept-fraction cut never run
 * Monte Carlo and never appear in the output.
 *
 * Flow:
 *   1. Pre-filter (tradingSignalScore >= 0, historyRows >= 100).
 *   2. Fetch OHLCV payloads for every pre-filtered stock.
 *   3. Score every stock with the LightGBM ranker in one batch.
 *   4. Sort by rank_pct desc; keep the top `rankerKeepPct` fraction; the
 *      rest are discarded (no GPS-Light fallback, no output row).
 *   5. Run Monte Carlo + GPS-Full on the survivors. Survivors that also
 *      clear the outlook-driven mlGate (predicted_change_pct floor) get
 *      surfaced; the rest are dropped silently.
 *
 * If the ranker subprocess fails or returns no scores, every pre-filtered
 * stock is treated as a survivor so the pipeline stays operational while
 * the error is loud in the logs — this is a degraded-mode fall-through,
 * not a normal behavior path.
 */
export async function analyzeStocks(
    stocks: EnrichedStock[],
    sharedContext?: { wbData?: any, marketIndices?: any },
    options: AnalyzeOptions = {},
): Promise<EnrichedStock[]> {
    const outlook                   = options.outlook                   ?? '1_month';
    const mlGate                    = options.mlGate                    ?? 1.5;
    const rankerKeepPct             = options.rankerKeepPct             ?? 0.25;
    const analystStrongBuyThreshold = options.analystStrongBuyThreshold ?? 4;
    const signalScoreFloor          = options.signalScoreFloor          ?? 0;
    const sectorLeaderTickers       = options.sectorLeaderTickers       ?? new Set<string>();

    // Pre-filter: skip enrichment failures, technical signals below the
    // preset-driven floor, or tickers with too little OHLCV history for
    // the ranker / MC to work.
    const initialFilteredStocks = stocks.filter(stock => {
        if (stock.error || stock.tradingSignalScore === undefined) {
            return false;
        }
        if (stock.historyRows !== undefined && stock.historyRows < 100) {
            return false;
        }
        return stock.tradingSignalScore >= signalScoreFloor;
    });

    if (initialFilteredStocks.length === 0) {
        return [];
    }

    // ─── Phase 1 — fetch OHLCV payloads for every pre-filtered stock ───────
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
    try {
        const sharedMacro = await fetchRankerSharedMacro();
        rankerScores = await scoreWithRanker(
            initialFilteredStocks,
            payloads,
            sharedMacro,
        );
        logger.info(`Ranker scored ${rankerScores.size}/${initialFilteredStocks.length} stocks`);
    } catch (err) {
        logger.error('Ranker scoring failed — degraded fall-through (all stocks treated as survivors)', { error: String(err) });
        rankerScores = new Map();
    }

    // ─── Phase 3 — hard cut at the top rankerKeepPct fraction ──────────────
    let rankerSurvivors: EnrichedStock[];
    if (rankerScores.size > 0) {
        const ranked = initialFilteredStocks
            .map(s => {
                const info = rankerScores.get(s.ticker);
                return info ? { stock: s, rankPct: info.rankPct } : null;
            })
            .filter((x): x is { stock: EnrichedStock; rankPct: number } => x !== null);

        ranked.sort((a, b) => b.rankPct - a.rankPct);
        const keepN = Math.max(1, Math.ceil(ranked.length * rankerKeepPct));
        rankerSurvivors = ranked.slice(0, keepN).map(r => r.stock);
        logger.info(`Ranker keep-cut: ${rankerSurvivors.length}/${ranked.length} survive at rankerKeepPct=${rankerKeepPct}`);
    } else {
        // Degraded fall-through (see Phase 2 catch).
        rankerSurvivors = initialFilteredStocks;
    }

    // ─── Phase 3b — analyst-strongBuy override lane ────────────────────────
    // Any pre-filtered stock whose current-month analyst strongBuy count
    // clears the algorithm-scaled threshold bypasses the ranker keep-cut.
    // These stocks still go through MC and must yield positive predicted
    // change to surface, but they skip the mlGate floor.
    const rankerTickers = new Set(rankerSurvivors.map(s => s.ticker));
    const analystOverrideStocks = initialFilteredStocks.filter(s =>
        !rankerTickers.has(s.ticker) &&
        (s.analystStrongBuy ?? 0) >= analystStrongBuyThreshold,
    );
    const analystOverrideTickers = new Set(analystOverrideStocks.map(s => s.ticker));
    if (analystOverrideStocks.length > 0) {
        logger.info(`Analyst override added ${analystOverrideStocks.length} stocks (threshold=${analystStrongBuyThreshold})`);
    }

    // ─── Phase 3c — sector-leader override lane ────────────────────────────
    // Stocks that are top-25 in any canonical Yahoo sector AND don't already
    // have a fresh stock_gps_scores row. They bypass both the ranker keep-cut
    // and the mlGate so /search/industry/[sector] always has GPS coverage.
    // Caller is responsible for the freshness pre-filter.
    const alreadySurfaced = new Set([...rankerTickers, ...analystOverrideTickers]);
    const sectorLeaderOverrideStocks = initialFilteredStocks.filter(s =>
        !alreadySurfaced.has(s.ticker) && sectorLeaderTickers.has(s.ticker),
    );
    const sectorLeaderOverrideTickers = new Set(sectorLeaderOverrideStocks.map(s => s.ticker));
    if (sectorLeaderOverrideStocks.length > 0) {
        logger.info(`Sector-leader override added ${sectorLeaderOverrideStocks.length} stocks (out of ${sectorLeaderTickers.size} stale leaders)`);
    }

    const survivors = [...rankerSurvivors, ...analystOverrideStocks, ...sectorLeaderOverrideStocks];

    // ─── Phase 4 — Monte Carlo + GPS-Full on ranker survivors only ─────────
    const filteredStocks: EnrichedStock[] = [];

    for (let i = 0; i < survivors.length; i += BATCH_SIZE) {
        const batch = survivors.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (stock) => {
            try {
                const payload = payloads.get(stock.ticker);
                if (!payload) {
                    logger.warn(`No payload cached for ${stock.ticker}, skipping MC`);
                    return;
                }

                const predictions: Record<string, any> = {};
                const timeframes = ['1_week', '1_month', '6_month', '1_year'] as const;
                for (const tf of timeframes) {
                    const result = await runPredictionInternal(stock.ticker, payload, tf);
                    predictions[tf] = result;
                }

                const predictionResult = predictions['1_month'];
                const predictedChangePct = predictionResult?.predicted_change_pct;
                if (predictedChangePct === undefined) return;

                stock.prediction_1m = predictedChangePct;

                const isAnalystOverride      = analystOverrideTickers.has(stock.ticker);
                const isSectorLeaderOverride = sectorLeaderOverrideTickers.has(stock.ticker);
                const passesMlGate           = predictedChangePct >= mlGate && predictedChangePct > 0;
                const passesAnalystGate      = isAnalystOverride && predictedChangePct > 0;
                // Sector-leader override unconditionally surfaces — the goal is
                // to write a GPS row for the sector tile UI, regardless of
                // whether today's prediction is bullish.
                const passesSectorLeaderGate = isSectorLeaderOverride;
                if (!(passesMlGate || passesAnalystGate || passesSectorLeaderGate)) {
                    return;
                }

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

                stock.prediction_input = {
                    ...predictionResult,
                    predicted_price_1w: predictions['1_week']?.predicted_price,
                    predicted_price_1m: predictions['1_month']?.predicted_price,
                    predicted_price_6m: predictions['6_month']?.predicted_price,
                    predicted_price_1y: predictions['1_year']?.predicted_price,
                };
                // Priority: v2_engine (true ranker survivor) > analyst_consensus > sector_leader.
                // A sector leader that *also* happens to pass the ml gate is recorded
                // as v2_engine — the override lane only labels stocks that surfaced
                // *because of* the override, not despite it.
                if (passesMlGate) {
                    stock.discovery_source = 'v2_engine';
                } else if (passesAnalystGate) {
                    stock.discovery_source = 'analyst_consensus';
                } else {
                    stock.discovery_source = 'sector_leader';
                }
                filteredStocks.push(stock);
            } catch (err) {
                logger.error(`Error processing prediction for ${stock.ticker}:`, { error: String(err) });
            }
        }));
    }

    // Suppress unused-param warnings for variables retained for future use.
    void outlook;

    return filteredStocks;
}
