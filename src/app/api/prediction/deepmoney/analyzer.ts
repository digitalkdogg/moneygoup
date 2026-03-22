import { createLogger } from '@/utils/logger';
import { appendFileSync } from 'fs';

const logger = createLogger('api/prediction/deepmoney/v2/analyzer');
const DEBUG_LOG = '/var/www/html/moneygoup/debug_analyzer.log';

function debugLog(msg: string) {
    const timestamp = new Date().toISOString();
    try {
        appendFileSync(DEBUG_LOG, `[${timestamp}] ${msg}\n`);
    } catch {
        // Ignore log errors
    }
}

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
    error?: string;
    prediction_1m?: number;
    gps_score?: number;
    classification?: string;
    sector?: string;
    prediction_input?: any;
}

/**
 * Analyzes and filters a list of enriched stocks.
 */
export async function analyzeStocks(stocks: EnrichedStock[]): Promise<EnrichedStock[]> {
    // First filter: stocks that have a 0 or positive tradingSignalScore
    const initialFilteredStocks = stocks.filter(stock => {
        if (stock.error || stock.tradingSignalScore === undefined) {
            return false;
        }
        return stock.tradingSignalScore >= 0;
    });

    if (initialFilteredStocks.length === 0) {
        return [];
    }

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET || '';

    const filteredStocks: EnrichedStock[] = [];
    
    for (const stock of initialFilteredStocks) {
        try {
            // 1. Fetch complete data payload for this stock
            const dataPath = `/api/stock_data/${stock.ticker}/data`;
            const dataUrl = `${baseUrl}${dataPath}`;
            
            const dataStart = Date.now();
            const dataRes = await fetch(dataUrl, {
                headers: { 'x-api-key': internalSecret },
            });
            const dataDuration = Date.now() - dataStart;

            // Log in the requested format: GET /path 200 in 123ms
            console.log(`GET ${dataPath} ${dataRes.status} in ${dataDuration}ms`);

            if (!dataRes.ok) {
                const errText = await dataRes.text();
                debugLog(`FAILED data fetch for ${stock.ticker}: ${dataRes.status} - ${errText}`);
                continue;
            }

            const payload = await dataRes.json();

            // 2. Call prediction endpoint with 1 month outlook
            const predictionPath = `/api/prediction/${stock.ticker}?outlook=1_month`;
            const predictionUrl = `${baseUrl}${predictionPath}`;
            
            const predStart = Date.now();
            const predictionRes = await fetch(predictionUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-api-key': internalSecret 
                },
                body: JSON.stringify(payload),
            });
            const predDuration = Date.now() - predStart;

            // Log in the requested format: POST /path 200 in 123ms
            console.log(`POST ${predictionPath} ${predictionRes.status} in ${predDuration}ms`);

            if (!predictionRes.ok) {
                continue;
            }

            const predictionResult: any = await predictionRes.json();
            const predictedChangePct = predictionResult.predicted_change_pct;

            if (predictedChangePct !== undefined) {
                stock.prediction_1m = predictedChangePct;
                // Threshold: 0.1%
                if (predictedChangePct >= 1.5) {
                    
                    // --- DB COMPATIBILITY CALCULATION ---
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
    }
    
    return filteredStocks;
}
