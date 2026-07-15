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
     *  always runs MC + GPS so the row is written regardless of outlook.
     *  'trending_48h' = surfaced from the Yahoo trending-48h feed; bypasses
     *  the signal-score pre-filter, the ranker keep-cut, the mlGate, AND the
     *  predicted-change-positive requirement. Coverage feed — every trending
     *  ticker with valid enrichment + ≥100 days history gets a GPS row. */
    discovery_source?: 'v2_engine' | 'analyst_consensus' | 'sector_leader' | 'trending_48h';

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
    /** Tickers from the Yahoo trending-48h feed. Coverage feed: bypass the
     *  signal-score pre-filter, the ranker keep-cut, the mlGate, AND the
     *  positive-prediction requirement. Surfaces unconditionally (like
     *  sector_leader) provided enrichment is valid and ≥100 days history. */
    trendingTickers?: Set<string>;
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
    const trendingTickers           = options.trendingTickers           ?? new Set<string>();

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

    // Trending pre-filter: same as above MINUS the signal-score floor. Trending
    // is a coverage feed — we want every Yahoo-trending ticker to get a GPS
    // row so the /search trending card shows a score, even when the technical
    // signal is bearish. Still require valid enrichment + 100 days history so
    // MC can actually run.
    const trendingPreFiltered = stocks.filter(stock => {
        if (!trendingTickers.has(stock.ticker)) return false;
        if (stock.error || stock.tradingSignalScore === undefined) return false;
        if (stock.historyRows !== undefined && stock.historyRows < 100) return false;
        return true;
    });

    if (initialFilteredStocks.length === 0 && trendingPreFiltered.length === 0) {
        return [];
    }

    // ─── Phase 1 — fetch OHLCV payloads for every candidate stock ──────────
    // Includes both the main pre-filter pool and the trending-only pool;
    // dedup by ticker so a trending stock that also cleared signal-score
    // only fetches once.
    const payloadCandidates = new Map<string, EnrichedStock>();
    for (const s of initialFilteredStocks) payloadCandidates.set(s.ticker, s);
    for (const s of trendingPreFiltered)   payloadCandidates.set(s.ticker, s);
    const stocksForPayload = Array.from(payloadCandidates.values());

    const payloads = new Map<string, any>();
    logger.info(`Phase 1: fetching prediction payloads for ${stocksForPayload.length} stock(s) in batches of ${BATCH_SIZE}`);
    let payloadDone = 0;
    const payloadStart = Date.now();
    for (let i = 0; i < stocksForPayload.length; i += BATCH_SIZE) {
        const batch = stocksForPayload.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (stock) => {
            try {
                const payload = await getStockDataForPrediction(stock.ticker, sharedContext?.wbData);
                payloads.set(stock.ticker, payload);
            } catch (err) {
                logger.error(`Payload fetch failed for ${stock.ticker}:`, { error: String(err) });
            }
        }));
        payloadDone += batch.length;
        const elapsedSec = (Date.now() - payloadStart) / 1000;
        logger.info(
            `Phase 1: fetched ${payloadDone}/${stocksForPayload.length} ` +
            `(${(100 * payloadDone / stocksForPayload.length).toFixed(1)}%) ` +
            `elapsed ${Math.round(elapsedSec)}s`
        );
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

    // ─── Phase 3c — trending-48h override lane ─────────────────────────────
    // Full-coverage feed: every Yahoo-trending ticker that has valid enrichment
    // + ≥100 days history gets MC + GPS, regardless of signal score or
    // predicted direction. Skips the ranker keep-cut, the signal-score floor,
    // and the mlGate so /search trending cards always render a GPS rating.
    // Sourced from trendingPreFiltered (broader pool than initialFilteredStocks).
    const trendingAlreadySurfaced = new Set([...rankerTickers, ...analystOverrideTickers]);
    const trendingOverrideStocks = trendingPreFiltered.filter(s =>
        !trendingAlreadySurfaced.has(s.ticker),
    );
    const trendingOverrideTickers = new Set(trendingOverrideStocks.map(s => s.ticker));
    if (trendingOverrideStocks.length > 0) {
        logger.info(`Trending-48h override added ${trendingOverrideStocks.length} stocks (out of ${trendingTickers.size} trending tickers)`);
    }

    // ─── Phase 3d — sector-leader override lane ────────────────────────────
    // Stocks that are top-25 in any canonical Yahoo sector AND don't already
    // have a fresh stock_gps_scores row. They bypass both the ranker keep-cut
    // and the mlGate so /search/industry/[sector] always has GPS coverage.
    // Caller is responsible for the freshness pre-filter.
    const alreadySurfaced = new Set([...rankerTickers, ...analystOverrideTickers, ...trendingOverrideTickers]);
    const sectorLeaderOverrideStocks = initialFilteredStocks.filter(s =>
        !alreadySurfaced.has(s.ticker) && sectorLeaderTickers.has(s.ticker),
    );
    const sectorLeaderOverrideTickers = new Set(sectorLeaderOverrideStocks.map(s => s.ticker));
    if (sectorLeaderOverrideStocks.length > 0) {
        logger.info(`Sector-leader override added ${sectorLeaderOverrideStocks.length} stocks (out of ${sectorLeaderTickers.size} stale leaders)`);
    }

    const survivors = [...rankerSurvivors, ...analystOverrideStocks, ...trendingOverrideStocks, ...sectorLeaderOverrideStocks];

    // ─── Phase 4 — Monte Carlo + GPS-Full on ranker survivors only ─────────
    const filteredStocks: EnrichedStock[] = [];
    logger.info(`Phase 4: running MC + GPS on ${survivors.length} survivor(s) in batches of ${BATCH_SIZE}`);

    let completed = 0;
    const phase4Start = Date.now();
    for (let i = 0; i < survivors.length; i += BATCH_SIZE) {
        const batch = survivors.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (stock) => {
            try {
                const payload = payloads.get(stock.ticker);
                if (!payload) {
                    logger.warn(`No payload cached for ${stock.ticker}, skipping MC`);
                    return;
                }

                // Python's --outlook='all' returns every horizon in one call.
                // Previously we spawned Python 4× per stock (one per horizon) and
                // paid the TF/Keras cold-load cost 4× for a computation the
                // script always does in full anyway. Collapsing to a single
                // spawn is the largest perf win in the sync pipeline.
                const allHorizons = await runPredictionInternal(stock.ticker, payload, 'all');
                if (!allHorizons || allHorizons.error) return;

                const predictedChangePct = allHorizons.predicted_change_pct_1m;
                if (predictedChangePct === undefined) return;

                // Reconstruct the per-horizon blobs the rest of this function
                // (and prediction_input downstream) already expected. Shape
                // matches what --outlook='<horizon>' used to return.
                const predictions: Record<string, any> = {
                    '1_week':  { predicted_price: allHorizons.predicted_price_1w,  predicted_change_pct: allHorizons.predicted_change_pct_1w, confidence_score: allHorizons.confidence_score_1w, predicted_range: allHorizons.predicted_range_1w },
                    '1_month': { predicted_price: allHorizons.predicted_price_1m,  predicted_change_pct: allHorizons.predicted_change_pct_1m, confidence_score: allHorizons.confidence_score_1m },
                    '6_month': { predicted_price: allHorizons.predicted_price_6m,  predicted_change_pct: allHorizons.predicted_change_pct_6m, confidence_score: allHorizons.confidence_score_6m, predicted_change_range: allHorizons.predicted_change_range },
                    '1_year':  { predicted_price: allHorizons.predicted_price_1y,  predicted_change_pct: allHorizons.predicted_change_pct_1y, confidence_score: allHorizons.confidence_score_1y },
                };
                // predictionResult was previously the 1_month filtered blob;
                // preserving the name keeps downstream code (GPS, prediction_input
                // spread) unchanged.
                const predictionResult = predictions['1_month'];

                stock.prediction_1m = predictedChangePct;

                const isAnalystOverride      = analystOverrideTickers.has(stock.ticker);
                const isTrendingOverride     = trendingOverrideTickers.has(stock.ticker);
                const isSectorLeaderOverride = sectorLeaderOverrideTickers.has(stock.ticker);
                const passesMlGate           = predictedChangePct >= mlGate && predictedChangePct > 0;
                const passesAnalystGate      = isAnalystOverride && predictedChangePct > 0;
                // Trending and sector-leader overrides unconditionally surface
                // — both are coverage feeds: trending writes a GPS row for the
                // /search trending card, sector-leader for /search/industry/[sector].
                // Bearish predictions are still persisted so the card has a
                // score; the dashboard gate downstream filters by predicted_change.
                const passesTrendingGate     = isTrendingOverride;
                const passesSectorLeaderGate = isSectorLeaderOverride;
                if (!(passesMlGate || passesAnalystGate || passesTrendingGate || passesSectorLeaderGate)) {
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

                // Spread the full --outlook='all' result so every _1w/_1m/_6m/_1y
                // key AND common metadata (data_quality, accuracy_metrics,
                // regime_info, llm_rationale, etc.) survive into prediction_input.
                // Legacy unsuffixed keys (predicted_change_pct, confidence_score,
                // predicted_price) are aliased to the 1_month values so consumers
                // like deepmoney_sync.py's `pred_input.get('confidence_score')`
                // (with no _1m fallback for metric_label) keep working.
                stock.prediction_input = {
                    ...allHorizons,
                    predicted_price:      allHorizons.predicted_price_1m,
                    predicted_change_pct: allHorizons.predicted_change_pct_1m,
                    confidence_score:     allHorizons.confidence_score_1m,
                };
                // Priority: v2_engine > analyst_consensus > trending_48h > sector_leader.
                // A stock that *also* happens to pass the ml gate is recorded as
                // v2_engine — the override lane only labels stocks that surfaced
                // *because of* the override, not despite it.
                if (passesMlGate) {
                    stock.discovery_source = 'v2_engine';
                } else if (passesAnalystGate) {
                    stock.discovery_source = 'analyst_consensus';
                } else if (passesTrendingGate) {
                    stock.discovery_source = 'trending_48h';
                } else {
                    stock.discovery_source = 'sector_leader';
                }
                filteredStocks.push(stock);
            } catch (err) {
                logger.error(`Error processing prediction for ${stock.ticker}:`, { error: String(err) });
            }
        }));

        // Per-batch heartbeat — makes the ~1h+ analyzer phase observable in
        // the dev server terminal. Logs ticker count + elapsed + rough ETA so
        // the operator can see "am I 20% through or 80% through" at a glance.
        completed += batch.length;
        const elapsedSec = (Date.now() - phase4Start) / 1000;
        const rate = completed / elapsedSec;  // stocks/sec
        const remainingSec = rate > 0 ? (survivors.length - completed) / rate : 0;
        const eta = remainingSec >= 60
            ? `${Math.round(remainingSec / 60)}m`
            : `${Math.round(remainingSec)}s`;
        logger.info(
            `Phase 4: processed ${completed}/${survivors.length} ` +
            `(${(100 * completed / survivors.length).toFixed(1)}%) ` +
            `elapsed ${Math.round(elapsedSec)}s, ETA ${eta}`
        );
    }

    // Suppress unused-param warnings for variables retained for future use.
    void outlook;

    return filteredStocks;
}
