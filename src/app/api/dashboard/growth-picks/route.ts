import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const logger = createLogger('api/dashboard/growth-picks');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export interface GrowthPickStock {
  symbol: string;
  name: string | undefined;
  regularMarketPrice: number;
  marketCap: number | undefined;
  trailingPE: number | undefined;
  priceToBook: number | undefined;
  fiftyTwoWeekLow: number | undefined;
  fiftyTwoWeekHigh: number | undefined;
  momentum6m: number | undefined;   // % price change over 6 months
  revenueGrowth: number | undefined; // TTM revenue growth %
  earningsGrowth: number | undefined;
  sector: string | undefined;
  scoreBreakdown: {
    priceScore: number;
    momentumScore: number;
    valuationScore: number;
    growthScore: number;
    totalScore: number;
  };
  growthThesis: string; // human-readable rationale
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Score a single stock candidate on four axes (0-25 each, 100 max).
 * Higher = more attractive for a buy-and-hold-1-year strategy.
 */
function scoreStock(
  price: number,
  momentum6m: number | undefined,
  pe: number | undefined,
  pb: number | undefined,
  revenueGrowth: number | undefined,
  earningsGrowth: number | undefined,
  fiftyTwoWeekLow: number | undefined,
  fiftyTwoWeekHigh: number | undefined,
): {
  priceScore: number;
  momentumScore: number;
  valuationScore: number;
  growthScore: number;
  totalScore: number;
} {
  // 1. Price Score (0-25): favour stocks well under $200 but not penny stocks
  let priceScore = 0;
  if (price >= 5 && price <= 50) priceScore = 25;
  else if (price > 50 && price <= 100) priceScore = 20;
  else if (price > 100 && price <= 150) priceScore = 15;
  else if (price > 150 && price <= 200) priceScore = 10;

  // 2. Momentum Score (0-25): positive but not frothy
  let momentumScore = 0;
  if (momentum6m !== undefined) {
    if (momentum6m >= 5 && momentum6m <= 30) momentumScore = 25;       // sweet spot
    else if (momentum6m > 30 && momentum6m <= 60) momentumScore = 15;  // strong but extended
    else if (momentum6m > 0 && momentum6m < 5) momentumScore = 10;    // barely moving
    else if (momentum6m < 0 && momentum6m >= -15) momentumScore = 5;  // mild pullback (potential value)
    // < -15%: 0 — avoid deep downtrends
  }

  // 3. Valuation Score (0-25): not wildly overvalued
  let valuationScore = 0;
  const peScore = pe !== undefined && pe > 0
    ? (pe < 15 ? 13 : pe < 25 ? 10 : pe < 40 ? 6 : 0)
    : 5; // no PE data — neutral-ish
  const pbScore = pb !== undefined && pb > 0
    ? (pb < 2 ? 12 : pb < 4 ? 9 : pb < 7 ? 5 : 0)
    : 5;
  valuationScore = peScore + pbScore;

  // 4. Growth Score (0-25)
  let growthScore = 0;
  if (revenueGrowth !== undefined) {
    if (revenueGrowth >= 20) growthScore += 13;
    else if (revenueGrowth >= 10) growthScore += 9;
    else if (revenueGrowth >= 0) growthScore += 4;
  } else {
    // Fall back to distance from 52-week low as a proxy
    if (fiftyTwoWeekLow !== undefined && fiftyTwoWeekHigh !== undefined) {
      const rangePos = (price - fiftyTwoWeekLow) / (fiftyTwoWeekHigh - fiftyTwoWeekLow + 0.01);
      // Prefer stocks in bottom 40-70% of their range — not at rock-bottom, not at peak
      if (rangePos >= 0.4 && rangePos <= 0.7) growthScore += 8;
      else if (rangePos > 0.7 && rangePos <= 0.85) growthScore += 4;
      else if (rangePos < 0.4) growthScore += 6; // Potential value bounce
    }
  }
  if (earningsGrowth !== undefined) {
    if (earningsGrowth >= 20) growthScore += 12;
    else if (earningsGrowth >= 10) growthScore += 8;
    else if (earningsGrowth >= 0) growthScore += 3;
  }
  growthScore = Math.min(growthScore, 25);

  const totalScore = priceScore + momentumScore + valuationScore + growthScore;
  return { priceScore, momentumScore, valuationScore, growthScore, totalScore };
}

/** Build a plain-English thesis sentence for the UI */
function buildThesis(stock: Partial<GrowthPickStock> & { scoreBreakdown: GrowthPickStock['scoreBreakdown'] }): string {
  const parts: string[] = [];

  if (stock.momentum6m !== undefined && stock.momentum6m >= 5) {
    parts.push(`+${stock.momentum6m.toFixed(1)}% 6-month momentum`);
  }
  if (stock.revenueGrowth !== undefined && stock.revenueGrowth >= 10) {
    parts.push(`${stock.revenueGrowth.toFixed(0)}% revenue growth`);
  }
  if (stock.earningsGrowth !== undefined && stock.earningsGrowth >= 10) {
    parts.push(`${stock.earningsGrowth.toFixed(0)}% earnings growth`);
  }
  if (stock.trailingPE !== undefined && stock.trailingPE > 0 && stock.trailingPE < 20) {
    parts.push(`attractive P/E of ${stock.trailingPE.toFixed(1)}`);
  }
  if (stock.sector) {
    parts.push(`${stock.sector} sector`);
  }
  if (parts.length === 0) {
    parts.push('Positive technical setup with room to run under $200');
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  try {
    logger.info('Fetching growth pick candidates');

    // Pull from multiple screener buckets for a wider candidate pool
    const [mostActives, undervalued, growthTech] = await Promise.all([
      yahooFinance.screener('most_actives').catch(() => ({ quotes: [] })),
      yahooFinance.screener('undervalued_growth_stocks').catch(() => ({ quotes: [] })),
      yahooFinance.screener('growth_technology_stocks').catch(() => ({ quotes: [] })),
    ]);

    // Deduplicate by symbol
    const seen = new Set<string>();
    const candidates = [
      ...mostActives.quotes,
      ...undervalued.quotes,
      ...growthTech.quotes,
    ].filter(q => {
      if (!q.symbol || !q.regularMarketPrice) return false;
      // Under $200 hard filter
      if (q.regularMarketPrice >= 200) return false;
      // Minimum $5 (avoid penny stocks)
      if (q.regularMarketPrice < 5) return false;
      // US equities only
      if (q.region && q.region !== 'US') return false;
      if (seen.has(q.symbol)) return false;
      seen.add(q.symbol);
      return true;
    });

    // For each candidate, enrich with 6-month price history + financials
    const enriched = await Promise.all(
      candidates.slice(0, 60).map(async (q) => {
        try {
          const sixMonthsAgo = new Date();
          sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

          const [chart, summary] = await Promise.all([
            yahooFinance.chart(q.symbol!, {
              interval: '1mo',
              period1: sixMonthsAgo,
            }).catch(() => ({ quotes: [] })),
            yahooFinance.quoteSummary(q.symbol!, {
              modules: ['financialData', 'defaultKeyStatistics'],
            }).catch(() => null),
          ]);

          // 6-month momentum
          let momentum6m: number | undefined;
          if (chart.quotes.length >= 2) {
            const first = chart.quotes[0].close;
            const last = chart.quotes[chart.quotes.length - 1].close;
            if (first && last && first > 0) {
              momentum6m = ((last - first) / first) * 100;
            }
          }

          const revenueGrowth = summary?.financialData?.revenueGrowth !== undefined
            ? (summary.financialData.revenueGrowth as number) * 100
            : undefined;
          const earningsGrowth = summary?.financialData?.earningsGrowth !== undefined
            ? (summary.financialData.earningsGrowth as number) * 100
            : undefined;

          const price = q.regularMarketPrice!;
          const pe = q.trailingPE;
          const pb = q.priceToBook;
          const low52 = q.fiftyTwoWeekLow;
          const high52 = q.fiftyTwoWeekHigh;

          const scoreBreakdown = scoreStock(price, momentum6m, pe, pb, revenueGrowth, earningsGrowth, low52, high52);

          const pick: GrowthPickStock = {
            symbol: q.symbol!,
            name: q.longName || q.shortName,
            regularMarketPrice: price,
            marketCap: q.marketCap,
            trailingPE: pe,
            priceToBook: pb,
            fiftyTwoWeekLow: low52,
            fiftyTwoWeekHigh: high52,
            momentum6m,
            revenueGrowth,
            earningsGrowth,
            sector: (q as any).sector,
            scoreBreakdown,
            growthThesis: '',
          };
          pick.growthThesis = buildThesis(pick);
          return pick;
        } catch {
          return null;
        }
      })
    );

    const results = enriched
      .filter((p): p is GrowthPickStock => p !== null && p.scoreBreakdown.totalScore >= 40)
      .sort((a, b) => b.scoreBreakdown.totalScore - a.scoreBreakdown.totalScore)
      .slice(0, 10);

    return NextResponse.json(results);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Error fetching growth picks:', err);
    return NextResponse.json(
      { error: 'Failed to fetch growth picks', details: err.message },
      { status: 500 }
    );
  }
}