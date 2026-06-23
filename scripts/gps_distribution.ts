/**
 * One-off: histogram of stock_gps_scores.gps_score across all stocks.
 * Informs whether the variant-B symmetric label scheme (Hold 45-55,
 * Buy 55-75, Strong Buy 75-100) matches the empirical distribution.
 *
 * Run: node --env-file=.env.local --import jiti/register scripts/gps_distribution.ts
 */
import { getDbConnection, closeDbPool } from '../src/utils/db';

async function main() {
  const pool = await getDbConnection();
  try {
    const [bucketRows] = await pool.query(
      `SELECT FLOOR(gps_score / 5) * 5 AS bucket, COUNT(*) AS n
       FROM stock_gps_scores
       GROUP BY bucket
       ORDER BY bucket`,
    ) as any;

    const [[stats]] = await pool.query(
      `SELECT
         COUNT(*)              AS total,
         ROUND(AVG(gps_score), 2) AS mean,
         ROUND(MIN(gps_score), 1) AS min,
         ROUND(MAX(gps_score), 1) AS max,
         ROUND(STDDEV(gps_score), 2) AS stddev
       FROM stock_gps_scores`,
    ) as any;
    // Compute median in JS (MySQL doesn't allow subqueries in OFFSET)
    const [medRows] = await pool.query(
      `SELECT gps_score FROM stock_gps_scores ORDER BY gps_score`,
    ) as any;
    const scores = (medRows as any[]).map(r => Number(r.gps_score)).sort((a, b) => a - b);
    const median = scores.length ? scores[Math.floor(scores.length / 2)].toFixed(1) : 'N/A';

    // Variant B band totals
    const [[bandCounts]] = await pool.query(
      `SELECT
         SUM(gps_score <  25) AS strong_sell,
         SUM(gps_score >= 25 AND gps_score < 45) AS sell,
         SUM(gps_score >= 45 AND gps_score < 55) AS hold,
         SUM(gps_score >= 55 AND gps_score < 75) AS buy,
         SUM(gps_score >= 75) AS strong_buy
       FROM stock_gps_scores`,
    ) as any;

    // Original getGpsLabel band totals for comparison
    const [[origBandCounts]] = await pool.query(
      `SELECT
         SUM(gps_score <  30) AS strong_sell,
         SUM(gps_score >= 30 AND gps_score < 45) AS sell,
         SUM(gps_score >= 45 AND gps_score < 65) AS hold,
         SUM(gps_score >= 65 AND gps_score < 80) AS buy,
         SUM(gps_score >= 80) AS strong_buy
       FROM stock_gps_scores`,
    ) as any;

    const total = Number(stats.total);
    console.log(`Total stocks scored:  ${total}`);
    console.log(`Mean / Median:        ${stats.mean} / ${median}`);
    console.log(`Min / Max / Stddev:   ${stats.min} / ${stats.max} / ${stats.stddev}`);

    console.log(`\n=== Histogram (5-pt buckets) ===`);
    const maxN = Math.max(...(bucketRows as any[]).map((r: any) => Number(r.n)));
    for (const r of bucketRows as any[]) {
      const n = Number(r.n);
      const bucket = Number(r.bucket);
      const pct = (n / total * 100).toFixed(1);
      const barLen = Math.round(40 * n / maxN);
      const bar = '█'.repeat(barLen);
      console.log(`  ${String(bucket).padStart(3)}-${String(bucket + 4).padStart(3)}  ${String(n).padStart(4)} (${pct.padStart(4)}%)  ${bar}`);
    }

    console.log(`\n=== Variant B bands (proposed for cards) ===`);
    const pctOf = (v: any) => ((Number(v) / total) * 100).toFixed(1);
    console.log(`  Strong Sell (0-25)    ${String(bandCounts.strong_sell).padStart(4)}  ${pctOf(bandCounts.strong_sell).padStart(5)}%`);
    console.log(`  Sell        (25-45)   ${String(bandCounts.sell).padStart(4)}  ${pctOf(bandCounts.sell).padStart(5)}%`);
    console.log(`  Hold        (45-55)   ${String(bandCounts.hold).padStart(4)}  ${pctOf(bandCounts.hold).padStart(5)}%`);
    console.log(`  Buy         (55-75)   ${String(bandCounts.buy).padStart(4)}  ${pctOf(bandCounts.buy).padStart(5)}%`);
    console.log(`  Strong Buy  (75-100)  ${String(bandCounts.strong_buy).padStart(4)}  ${pctOf(bandCounts.strong_buy).padStart(5)}%`);

    console.log(`\n=== Original getGpsLabel bands (current canonical) ===`);
    console.log(`  Strong Sell (0-30)    ${String(origBandCounts.strong_sell).padStart(4)}  ${pctOf(origBandCounts.strong_sell).padStart(5)}%`);
    console.log(`  Sell        (30-45)   ${String(origBandCounts.sell).padStart(4)}  ${pctOf(origBandCounts.sell).padStart(5)}%`);
    console.log(`  Hold        (45-65)   ${String(origBandCounts.hold).padStart(4)}  ${pctOf(origBandCounts.hold).padStart(5)}%`);
    console.log(`  Buy         (65-80)   ${String(origBandCounts.buy).padStart(4)}  ${pctOf(origBandCounts.buy).padStart(5)}%`);
    console.log(`  Strong Buy  (80-100)  ${String(origBandCounts.strong_buy).padStart(4)}  ${pctOf(origBandCounts.strong_buy).padStart(5)}%`);
  } finally {
    await closeDbPool();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
