import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { yahooFinance, getSectorStocks } from '@/utils/yahooFinanceHelper';
import { isCanonicalSector } from '@/utils/sectorTaxonomy';
import { getDbConnection } from '@/utils/db';

const RESULT_LIMIT = 10;
const SCREENER_FETCH = 50;        // pull more than RESULT_LIMIT — many leaders are filtered out by the price ceiling
const PRICE_CEILING  = 300;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const originError = checkOrigin(request);
    if (originError) return originError;

    const session = await getServerSession(authOptions);
    if (!session) return unauthorizedResponse();

    const approvalOutcome = await checkApprovalGuard(session.user?.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }

    const { ticker: rawInput } = await params;
    const decodedInput = decodeURIComponent(rawInput).replace(/_/g, ' ');

    if (!isCanonicalSector(decodedInput)) {
      return NextResponse.json({
        input: decodedInput,
        industry: decodedInput,
        stocks: [],
        message: `No specific matches found for "${decodedInput}".`,
      });
    }

    // 1. Sector leaders from Yahoo's ms_<sector> screener
    const sectorQuotes = await getSectorStocks(decodedInput, SCREENER_FETCH);
    const targetSymbols = (sectorQuotes as any[]).map((q: any) => q.symbol).filter(Boolean);
    if (targetSymbols.length === 0) {
      return NextResponse.json({
        input: decodedInput,
        industry: decodedInput,
        stocks: [],
        message: `No specific matches found for "${decodedInput}".`,
      });
    }

    // 2. Live quote refresh + GPS lookup, in parallel.
    //    Uses pool.query (not executeRawQuery / prepared statement) because
    //    mysql2's `execute` does not expand arrays into IN-clause placeholders;
    //    `query` does.
    const uniqueSymbols = Array.from(new Set(targetSymbols));
    const pool = await getDbConnection();
    const [detailedQuotesRaw, gpsQueryResult] = await Promise.all([
      yahooFinance.quote(uniqueSymbols),
      pool.query(
        `SELECT s.symbol, sgs.gps_score, sgs.gps_breakdown, sgs.as_of
         FROM stocks s
         LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
         WHERE s.symbol IN (?)`,
        [uniqueSymbols],
      ),
    ]);

    const gpsRows = (gpsQueryResult as any)[0] as any[];
    const gpsBySymbol = new Map<string, { gps_score: number | null; gps_breakdown: any; as_of: string | null }>();
    for (const r of gpsRows) {
      gpsBySymbol.set(r.symbol, {
        gps_score: r.gps_score != null ? parseFloat(r.gps_score) : null,
        gps_breakdown: r.gps_breakdown
          ? (typeof r.gps_breakdown === 'string' ? JSON.parse(r.gps_breakdown) : r.gps_breakdown)
          : null,
        as_of: r.as_of ? new Date(r.as_of).toISOString() : null,
      });
    }

    const quoteArray = Array.isArray(detailedQuotesRaw) ? detailedQuotesRaw : [];

    // Filter on price ceiling (preserves prior behavior)
    const eligibleQuotes = quoteArray.filter((q: any) => q && q.regularMarketPrice && q.regularMarketPrice < PRICE_CEILING);

    if (eligibleQuotes.length === 0) {
      return NextResponse.json({
        input: decodedInput,
        industry: decodedInput,
        stocks: [],
        message: `No stocks found with price < $${PRICE_CEILING} for "${decodedInput}".`,
      });
    }

    // 3. Project + attach GPS. Stocks without a stock_gps_scores row appear with
    //    gps_score: null and will render a placeholder ("—") in the UI.
    const projected = eligibleQuotes.map((q: any) => {
      const gps = gpsBySymbol.get(q.symbol);
      const range = (q.fiftyTwoWeekHigh || 0) - (q.fiftyTwoWeekLow || 0);
      const fiftyTwoWeekPosition = range > 0
        ? (((q.regularMarketPrice || 0) - (q.fiftyTwoWeekLow || 0)) / range) * 100
        : 50;

      return {
        symbol: q.symbol,
        name: q.longName || q.shortName || q.symbol,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        marketCap: q.marketCap,
        volume: q.regularMarketVolume,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow,
        fiftyTwoWeekPosition,
        gps_score: gps?.gps_score ?? null,
        gps_breakdown: gps?.gps_breakdown ?? null,
        gps_as_of: gps?.as_of ?? null,
      };
    });

    // 4. Sort by GPS desc, nulls last; cap at RESULT_LIMIT.
    //    Null-GPS rows still surface — they reveal sector leaders the nightly
    //    sync hasn't covered yet, and the UI renders them with a placeholder.
    projected.sort((a, b) => {
      if (a.gps_score == null && b.gps_score == null) return 0;
      if (a.gps_score == null) return 1;
      if (b.gps_score == null) return -1;
      return b.gps_score - a.gps_score;
    });

    return NextResponse.json({
      input: decodedInput,
      industry: decodedInput,
      horizonLabel: '1-month baseline',  // /portfolio and /search/[ticker] apply per-user horizon adjustment; the browse page uses the absolute baseline
      stocks: projected.slice(0, RESULT_LIMIT),
    });

  } catch (error) {
    console.error('=== ERROR in industry sector API ===');
    if (error instanceof Error) {
      console.error('Error message:', error.message);
    } else {
      console.error('Raw error:', String(error));
    }
    return createErrorResponse(error, 'Internal Server Error');
  }
}
