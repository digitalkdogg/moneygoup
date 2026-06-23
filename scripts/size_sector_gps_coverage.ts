/**
 * One-off: size the sector-leader universe and measure how much GPS coverage
 * we already have. Informs the deepmoney_sync pre-warm step.
 *
 * Run with: node --env-file=.env.local --import jiti/register scripts/size_sector_gps_coverage.ts
 */
import { getSectorStocks } from '../src/utils/yahooFinanceHelper';
import { CANONICAL_SECTORS } from '../src/utils/sectorTaxonomy';
import { getDbConnection, closeDbPool } from '../src/utils/db';

const FRESH_HOURS = 36;

async function main() {
  // 1. Pull sector leaders (top 25 by intraday market cap, matches what /search uses)
  console.log(`Pulling top-25 leaders for ${CANONICAL_SECTORS.length} canonical sectors...\n`);

  const symbolsBySector: Record<string, string[]> = {};
  for (const sector of CANONICAL_SECTORS) {
    const quotes = await getSectorStocks(sector, 25);
    const symbols = (quotes as any[]).map((q: any) => q.symbol).filter(Boolean);
    symbolsBySector[sector] = symbols;
    console.log(`  ${sector.padEnd(26)} ${symbols.length} symbols`);
  }

  // 2. Union + overlap analysis
  const tickerSectorCount: Record<string, number> = {};
  for (const [, syms] of Object.entries(symbolsBySector)) {
    for (const s of syms) {
      tickerSectorCount[s] = (tickerSectorCount[s] || 0) + 1;
    }
  }
  const uniqueTickers = Object.keys(tickerSectorCount);
  const overlapTickers = uniqueTickers.filter(t => tickerSectorCount[t] > 1);

  console.log(`\n=== Universe size ===`);
  console.log(`  Total ticker slots (sum across sectors): ${Object.values(symbolsBySector).reduce((a, b) => a + b.length, 0)}`);
  console.log(`  Distinct tickers:                        ${uniqueTickers.length}`);
  console.log(`  Tickers appearing in 2+ sectors:         ${overlapTickers.length}`);
  if (overlapTickers.length > 0) {
    console.log(`  Examples: ${overlapTickers.slice(0, 10).map(t => `${t}(x${tickerSectorCount[t]})`).join(', ')}`);
  }

  // 3. DB coverage check
  console.log(`\n=== GPS coverage in stock_gps_scores ===`);
  const pool = await getDbConnection();
  try {
    // Anything not in stocks at all
    const [stockRows] = await pool.query(
      `SELECT id, symbol FROM stocks WHERE symbol IN (?)`,
      [uniqueTickers]
    ) as any;
    const stockIdBySymbol: Record<string, number> = {};
    for (const r of stockRows) stockIdBySymbol[r.symbol] = r.id;
    const inStocks = Object.keys(stockIdBySymbol);
    const notInStocks = uniqueTickers.filter(t => !(t in stockIdBySymbol));

    // GPS rows for the stocks we do have
    const stockIds = Object.values(stockIdBySymbol);
    let gpsRows: any[] = [];
    if (stockIds.length > 0) {
      const [rows] = await pool.query(
        `SELECT stock_id, as_of FROM stock_gps_scores WHERE stock_id IN (?)`,
        [stockIds]
      ) as any;
      gpsRows = rows;
    }
    const gpsByStockId: Record<number, Date> = {};
    for (const r of gpsRows) gpsByStockId[r.stock_id] = new Date(r.as_of);

    const now = Date.now();
    const freshMs = FRESH_HOURS * 60 * 60 * 1000;
    let fresh = 0, stale = 0, missing = 0;
    const staleExamples: string[] = [];
    const missingExamples: string[] = [];
    for (const sym of inStocks) {
      const id = stockIdBySymbol[sym];
      const asOf = gpsByStockId[id];
      if (!asOf) {
        missing++;
        if (missingExamples.length < 8) missingExamples.push(sym);
      } else if (now - asOf.getTime() <= freshMs) {
        fresh++;
      } else {
        stale++;
        if (staleExamples.length < 8) staleExamples.push(`${sym}(${Math.round((now - asOf.getTime()) / 86400000)}d)`);
      }
    }

    console.log(`  In stocks table:                ${inStocks.length} / ${uniqueTickers.length}`);
    console.log(`  Not in stocks table:            ${notInStocks.length}${notInStocks.length > 0 ? ` (${notInStocks.slice(0, 8).join(', ')}${notInStocks.length > 8 ? '...' : ''})` : ''}`);
    console.log(`  Fresh GPS (<${FRESH_HOURS}h):              ${fresh}`);
    console.log(`  Stale GPS (older):              ${stale}${stale > 0 ? ` (e.g. ${staleExamples.join(', ')})` : ''}`);
    console.log(`  In stocks but no GPS row:       ${missing}${missing > 0 ? ` (${missingExamples.join(', ')}${missing > 8 ? '...' : ''})` : ''}`);

    // What the nightly sync would need to do
    console.log(`\n=== Nightly sync work estimate ===`);
    console.log(`  Predictions to run (stale + missing + not_in_stocks): ${stale + missing + notInStocks.length}`);
    console.log(`  Predictions already covered (fresh):                  ${fresh}`);
  } finally {
    await closeDbPool();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
