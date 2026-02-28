import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

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
    modules: ["assetProfile", "price", "summaryDetail", "quoteType", "financialData", "defaultKeyStatistics", "incomeStatementHistory", "earningsTrend"],
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

