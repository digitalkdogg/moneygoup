import { getTickerSector, getTrendingStocks } from '../src/utils/yahooFinanceHelper';

const SAMPLE_TICKERS = [
  // Tech / semis / software
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMD', 'INTC', 'AVGO', 'CRM', 'ORCL',
  'ADBE', 'CSCO', 'TXN', 'QCOM', 'NOW', 'IBM', 'PANW', 'CRWD', 'PLTR', 'MU',
  // Financials / banks / insurance
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'AXP', 'BLK', 'SCHW', 'BRK-B',
  'V', 'MA', 'PYPL', 'COF', 'USB', 'PNC', 'MET', 'PRU', 'AIG', 'TRV',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'EOG', 'PSX', 'MPC', 'VLO', 'HAL',
  // Healthcare / pharma / biotech / devices
  'JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'LLY', 'TMO', 'ABT', 'BMY', 'AMGN',
  'GILD', 'CVS', 'CI', 'ELV', 'ISRG', 'MDT', 'SYK', 'BSX', 'REGN', 'VRTX',
  // Industrials / aerospace / machinery / defense
  'CAT', 'DE', 'BA', 'GE', 'HON', 'LMT', 'RTX', 'NOC', 'UPS', 'FDX',
  'MMM', 'EMR', 'ETN', 'PH', 'CMI', 'GD', 'WM', 'CSX', 'NSC', 'UNP',
  // Consumer cyclical / retail / autos / hospitality
  'AMZN', 'TSLA', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'TJX', 'BKNG', 'CMG',
  'F', 'GM', 'ABNB', 'MAR', 'HLT', 'RCL', 'CCL', 'LVS', 'EBAY', 'LULU',
  // Consumer defensive / staples
  'WMT', 'PG', 'KO', 'PEP', 'COST', 'PM', 'MO', 'MDLZ', 'CL', 'KMB',
  'GIS', 'K', 'SYY', 'KR', 'STZ', 'CHD', 'EL', 'HSY', 'TSN', 'CAG',
  // Materials / chemicals / mining / gold
  'LIN', 'APD', 'SHW', 'ECL', 'DD', 'DOW', 'NEM', 'FCX', 'GOLD', 'AA',
  'NUE', 'VMC', 'MLM', 'CF', 'MOS',
  // REITs / real estate
  'AMT', 'PLD', 'EQIX', 'CCI', 'PSA', 'O', 'SPG', 'WELL', 'DLR', 'AVB',
  // Communication services / telecom / media
  'T', 'VZ', 'TMUS', 'NFLX', 'DIS', 'CMCSA', 'CHTR', 'EA', 'TTWO', 'WBD',
  // Utilities
  'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'XEL', 'SRE', 'WEC', 'ED',
];

async function main() {
  const sectorByTicker: Record<string, string | null> = {};
  const tickerSet = new Set<string>(SAMPLE_TICKERS);

  // Pull trending and add to sample for additional coverage.
  try {
    const trending = await getTrendingStocks(40);
    for (const q of trending as any[]) {
      if (q?.symbol) tickerSet.add(q.symbol);
    }
    console.log(`Added ${trending.length} trending tickers to sample`);
  } catch (e) {
    console.warn('Trending fetch failed, continuing with hardcoded list:', e);
  }

  const tickers = Array.from(tickerSet);
  console.log(`Resolving sectors for ${tickers.length} tickers...`);

  // Run with limited concurrency to avoid rate limiting
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < tickers.length) {
      const i = idx++;
      const t = tickers[i];
      try {
        const sector = await getTickerSector(t);
        sectorByTicker[t] = sector;
        if (i % 20 === 0) console.log(`  [${i}/${tickers.length}] ${t} -> ${sector}`);
      } catch (e) {
        sectorByTicker[t] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Tally distinct sectors
  const counts: Record<string, number> = {};
  const nullTickers: string[] = [];
  for (const [t, s] of Object.entries(sectorByTicker)) {
    if (!s) {
      nullTickers.push(t);
      continue;
    }
    counts[s] = (counts[s] || 0) + 1;
  }

  console.log('\n=== Distinct Yahoo sectors found ===');
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [sector, n] of sorted) {
    console.log(`  ${JSON.stringify(sector).padEnd(30)} ${n}`);
  }
  console.log(`\nTotal distinct sectors: ${sorted.length}`);
  console.log(`Tickers with null sector: ${nullTickers.length} (${nullTickers.slice(0, 10).join(', ')}${nullTickers.length > 10 ? '...' : ''})`);

  console.log('\n=== Sample mapping (first 20) ===');
  for (const [t, s] of Object.entries(sectorByTicker).slice(0, 20)) {
    console.log(`  ${t.padEnd(8)} ${s}`);
  }
}

main().catch(e => {
  console.error('Discovery script failed:', e);
  process.exit(1);
});
