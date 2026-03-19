import { createLogger } from '@/utils/logger';

const logger = createLogger('api/prediction/deepmoney/v2/analyzer');

/**
 * Interface representing a stock with its enriched metrics.
 * This matches the structure returned by enrichTickers in route.ts.
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
    sma20?: number | null;
    sma50?: number | null;
    rsi?: number | null;
    tradingSignal?: string;
    tradingSignalScore?: number;
    signalStrength?: number;
    error?: string;
}

/**
 * Analyzes and filters a list of enriched stocks.
 * Filters for stocks that have a non-negative tradingSignalScore.
 * 
 * @param stocks - The list of enriched stocks to analyze
 * @returns A filtered list of stocks that meet the analysis criteria
 */
export function analyzeStocks(stocks: EnrichedStock[]): EnrichedStock[] {
    logger.info(`Analyzing ${stocks.length} stocks for positive trading signals`);

    // Filter down to just stocks that have a 0 or positive tradingSignalScore
    const filteredStocks = stocks.filter(stock => {
        // Skip stocks that had enrichment errors or missing score
        if (stock.error || stock.tradingSignalScore === undefined) {
            return false;
        }
        
        return stock.tradingSignalScore >= 0;
    });

    logger.info(`Analysis complete. ${filteredStocks.length} stocks passed the filter.`);
    
    return filteredStocks;
}
