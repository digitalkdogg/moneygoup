import { createLogger } from '@/utils/logger';
import { getStockDataForPrediction, runPredictionInternal } from '@/utils/stockDataHelper';
import { calculateGpsScore } from '@/utils/gps';

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
}

/** Options that drive how the analyzer runs the ML and gates the results. */
export interface AnalyzeOptions {
    /** outlook passed to predict_weighted_analysis.py — '1_week' / '1_month' / '6_month' / '1_year'. */
    outlook?: '1_week' | '1_month' | '6_month' | '1_year';
    /** Minimum positive predicted change % required to surface (ML Validation Gate). */
    mlGate?: number;
}

/**
 * Analyzes and filters a list of enriched stocks.
 * Uses Direct Logic approach to avoid internal HTTP overhead.
 */
export async function analyzeStocks(
    stocks: EnrichedStock[],
    sharedContext?: { wbData?: any, marketIndices?: any },
    options: AnalyzeOptions = {},
): Promise<EnrichedStock[]> {
    const outlook = options.outlook ?? '1_month';
    const mlGate  = options.mlGate  ?? 1.5;

    // First filter: stocks that have a positive or neutral tradingSignalScore
    // This pre-filtering reduces the number of heavy prediction calls
    const initialFilteredStocks = stocks.filter(stock => {
        if (stock.error || stock.tradingSignalScore === undefined) {
            return false;
        }
        // User requested: skip if < 100 rows found in discovery enrichment pass
        // (If it doesn't have 100 rows in 1 year, it won't have 504 in 5 years)
        if (stock.historyRows !== undefined && stock.historyRows < 100) {
            return false;
        }
        return stock.tradingSignalScore >= 0;
    });

    if (initialFilteredStocks.length === 0) {
        return [];
    }

    const filteredStocks: EnrichedStock[] = [];

    // Process in smaller serial batches or with limited concurrency to respect CPU/Memory
    const BATCH_SIZE = 3;
    for (let i = 0; i < initialFilteredStocks.length; i += BATCH_SIZE) {
        const batch = initialFilteredStocks.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (stock) => {
            try {
                // 1. Get complete data payload WITHOUT internal fetch
                const payload = await getStockDataForPrediction(stock.ticker, sharedContext?.wbData);

                // 2. Run prediction WITHOUT internal fetch — outlook scales with the user's timeframe
                const predictionResult: any = await runPredictionInternal(stock.ticker, payload, outlook);

                const predictedChangePct = predictionResult.predicted_change_pct;

                if (predictedChangePct !== undefined) {
                    stock.prediction_1m = predictedChangePct;
                    // Threshold: positive predictions >= mlGate only (timeframe-scaled ML Validation Gate)
                    if (predictedChangePct > 0 && predictedChangePct >= mlGate) {
                        
                        // --- GPS Score Calculation (v2.3) ---
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

                        const rdSpendPct = (stock.researchDevelopment || 0) / (stock.totalRevenue || 1);
                        if ((stock.revenueGrowth || 0) >= 0.20 && (stock.grossMargins || 0) >= 0.50 && rdSpendPct >= 0.10) {
                            stock.classification = 'ai_tech_hyper_growth';
                        } else if ((stock.revenueGrowth || 0) >= 0.10 && (stock.fiftyTwoWeekChange || 0) >= 0.10) {
                            stock.classification = 'established_growth';
                        } else {
                            stock.classification = 'standard';
                        }

                        stock.prediction_input = predictionResult;
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
