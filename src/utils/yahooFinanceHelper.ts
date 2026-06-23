import YahooFinance from 'yahoo-finance2';
import { SECTOR_TO_SCRID, isCanonicalSector } from './sectorTaxonomy';

// Instantiate once at module load time
let yahooFinanceInstance: any = null;

function getYahooFinance() {
  if (!yahooFinanceInstance) {
    yahooFinanceInstance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logOptionsErrors: false },
});
  }
  return yahooFinanceInstance;
}

export const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logOptionsErrors: false },
});

export async function getTrendingStocks(count: number = 12) {
  try {
    const yf = getYahooFinance();
    const result = await yf.screener({
      scrIds: 'most_actives',
      count: Math.min(count, 100)
    });
    return result?.quotes || [];
  } catch (error) {
    console.error('Error fetching trending stocks from Yahoo Finance:', error);
    return [];
  }
}

export async function fetchYahooQuotesForSymbols(
  symbols: string[],
  stockIdMap: Map<string, number>
) {
  if (symbols.length === 0) {
    return [];
  }

  const yahooFinanceData = await yahooFinance.quote(symbols);

  const combinedData = yahooFinanceData.map(data => ({
    stock_id: stockIdMap.get(data.symbol || '') || null,
    symbol: data.symbol,
    companyName: data.longName || data.shortName || 'N/A',
    price: data.regularMarketPrice || null,
    daily_change: data.regularMarketChange || null,
    marketCap: data.marketCap || null,
    trailingPE: data.trailingPE || null,
    priceToBook: data.priceToBook || null,
  }));

  return combinedData;
}

export async function fetchYahooStockSummary(ticker: string) {
  const summary = await yahooFinance.quoteSummary(ticker, {
    modules: ["assetProfile", "price", "summaryDetail", "quoteType", "financialData", "defaultKeyStatistics", "earningsTrend", "recommendationTrend"],
  });
  return summary;
}

export async function getYahooScreener(screenerName: string) {
  try {
    return await (yahooFinance.screener as any)(screenerName);
  } catch (error) {
    console.error(`Error fetching screener ${screenerName}:`, error);
    return { quotes: [] };
  }
}

export async function getTickerSector(ticker: string) {
  try {
    const summary = await yahooFinance.quoteSummary(ticker, {
      modules: ["assetProfile"],
    });
    return summary.assetProfile?.sector || null;
  } catch (error) {
    console.error(`Error fetching sector for ticker ${ticker}:`, error);
    return null;
  }
}

export async function getSectorStocks(sectorName: string, count: number = 25) {
  if (!isCanonicalSector(sectorName)) {
    console.warn(`getSectorStocks called with non-canonical sector: "${sectorName}"`);
    return [];
  }
  const scrId = SECTOR_TO_SCRID[sectorName];
  try {
    const result = await (yahooFinance.screener as any)(
      { scrIds: scrId, count },
      undefined,
      { validateOptions: false, validateResult: false }
    );
    return (result as any)?.quotes || [];
  } catch (error) {
    console.error(`Error fetching stocks for sector ${sectorName} (scrId=${scrId}):`, error);
    return [];
  }
}

