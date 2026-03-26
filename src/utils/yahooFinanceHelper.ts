import YahooFinance from 'yahoo-finance2';

export const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

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
    modules: ["assetProfile", "price", "summaryDetail", "quoteType", "financialData", "defaultKeyStatistics", "incomeStatementHistory", "earningsTrend", "recommendationTrend"],
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

export async function getSectorStocks(sectorName: string) {
  try {
    const result = await (yahooFinance.screener as any)({
      scrIds: 'most_actives',
      query: {
        operator: 'AND',
        operands: [{ operator: 'EQ', operands: ['sector', sectorName] }]
      }
    }, undefined, { validateOptions: false });
    return result.quotes || [];
  } catch (error) {
    console.error(`Error fetching stocks for sector ${sectorName}:`, error);
    return [];
  }
}

