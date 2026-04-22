import { createLogger } from '@/utils/logger';
import { getStockDataForPrediction, runPredictionInternal } from '@/utils/stockDataHelper';

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
    signalStrength?: number;
    historyRows?: number;
    error?: string;
    prediction_1m?: number;
    gps_score?: number;
    classification?: string;
    sector?: string;
    prediction_input?: any;
}

/**
 * Analyzes and filters a list of enriched stocks.
 * Uses Direct Logic approach to avoid internal HTTP overhead.
 */
export async function analyzeStocks(stocks: EnrichedStock[], sharedContext?: { wbData?: any, marketIndices?: any }): Promise<EnrichedStock[]> {
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

                // 2. Run prediction WITHOUT internal fetch
                const predictionResult: any = await runPredictionInternal(stock.ticker, payload, '1_month');
                
                const predictedChangePct = predictionResult.predicted_change_pct;

                if (predictedChangePct !== undefined) {
                    stock.prediction_1m = predictedChangePct;
                    // Threshold: positive predictions >= 1.5% only
                    if (predictedChangePct > 0 && predictedChangePct >= 1.5) {
                        
                        // --- GPS Score Calculation ---
                        let gps = 0;
                        const analystUpside = stock.analystUpside || 0;
                        const revenueGrowth = stock.revenueGrowth || 0;
                        const earningsGrowth = stock.earningsGrowth || 0;
                        const fiftyTwoWeekChange = stock.fiftyTwoWeekChange || 0;

                        gps += Math.min(Math.max(analystUpside / 0.3, 0), 1) * 25;
                        gps += Math.min(Math.max(revenueGrowth / 0.3, 0), 1) * 25;
                        gps += Math.min(Math.max(earningsGrowth / 0.25, 0), 1) * 25;
                        gps += Math.min(Math.max(fiftyTwoWeekChange / 0.2, 0), 1) * 25;
                        
                        if (predictedChangePct > 0.5) gps += 5;
                        
                        stock.gps_score = parseFloat(Math.min(gps, 100).toFixed(1));

                        const rdSpendPct = (stock.researchDevelopment || 0) / (stock.totalRevenue || 1);
                        if (revenueGrowth >= 0.20 && (stock.grossMargins || 0) >= 0.50 && rdSpendPct >= 0.10) {
                            stock.classification = 'ai_tech_hyper_growth';
                        } else if (revenueGrowth >= 0.10 && fiftyTwoWeekChange >= 0.10) {
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
