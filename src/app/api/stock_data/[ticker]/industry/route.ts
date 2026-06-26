import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { yahooFinance, getSectorStocks } from '@/utils/yahooFinanceHelper';
import { isCanonicalSector } from '@/utils/sectorTaxonomy';
import { getDbConnection } from '@/utils/db';
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy';

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

    // Resolve the user's investment timeframe so the table reports a
    // horizon-aware predicted price (1W / 1M / 6M / 1Y) matching the dashboard
    // and trending grid views. Falls back to the default strategy on lookup error.
    const userId = session.user?.id;
    const userStrategy = userId != null
      ? await getUserStrategy(userId).catch(() => DEFAULT_STRATEGY)
      : DEFAULT_STRATEGY;
    const timeframeConfig = resolveStrategy(userStrategy).timeframe;
    const priceColumn = timeframeConfig.predictedPriceColumn;
    const sfx = priceColumn.replace('predicted_price_', ''); // '1w' | '1m' | '6m' | '1y'
    const horizonLabel = timeframeConfig.shortLabel;

    // 2. Live quote refresh + GPS + per-user horizon prediction, in parallel.
    //    Uses pool.query (not executeRawQuery / prepared statement) because
    //    mysql2's `execute` does not expand arrays into IN-clause placeholders;
    //    `query` does.
    const uniqueSymbols = Array.from(new Set(targetSymbols));
    const pool = await getDbConnection();
    const predictionSelect = userId != null
      ? `COALESCE(usp.${priceColumn}, usp.predicted_price_1m) AS predicted_price_horizon,
         usp.predicted_change_pct_${sfx} AS predicted_change_pct_horizon`
      : `NULL AS predicted_price_horizon, NULL AS predicted_change_pct_horizon`;
    const predictionJoin = userId != null
      ? `LEFT JOIN user_stock_predictions usp ON usp.stock_id = s.id AND usp.user_id = ?`
      : '';
    const enrichmentParams: any[] = userId != null ? [userId, uniqueSymbols] : [uniqueSymbols];

    const [detailedQuotesRaw, enrichmentResult] = await Promise.all([
      yahooFinance.quote(uniqueSymbols),
      pool.query(
        `SELECT s.symbol, sgs.gps_score, sgs.gps_breakdown, sgs.as_of,
                ${predictionSelect}
         FROM stocks s
         LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
         ${predictionJoin}
         WHERE s.symbol IN (?)`,
        enrichmentParams,
      ),
    ]);

    const enrichmentRows = (enrichmentResult as any)[0] as any[];
    const enrichBySymbol = new Map<string, {
      gps_score: number | null;
      gps_breakdown: any;
      as_of: string | null;
      predicted_price_horizon: number | null;
      predicted_change_pct_horizon: number | null;
    }>();
    for (const r of enrichmentRows) {
      enrichBySymbol.set(r.symbol, {
        gps_score: r.gps_score != null ? parseFloat(r.gps_score) : null,
        gps_breakdown: r.gps_breakdown
          ? (typeof r.gps_breakdown === 'string' ? JSON.parse(r.gps_breakdown) : r.gps_breakdown)
          : null,
        as_of: r.as_of ? new Date(r.as_of).toISOString() : null,
        predicted_price_horizon: r.predicted_price_horizon != null ? parseFloat(r.predicted_price_horizon) : null,
        predicted_change_pct_horizon: r.predicted_change_pct_horizon != null ? parseFloat(r.predicted_change_pct_horizon) : null,
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

    // 3. Project + attach GPS + per-user horizon prediction. Stocks without
    //    a stock_gps_scores row or a user_stock_predictions row appear with
    //    null fields; the UI renders placeholders ("—") for those.
    const projected = eligibleQuotes.map((q: any) => {
      const enrich = enrichBySymbol.get(q.symbol);
      const currentPrice = q.regularMarketPrice ?? null;

      // Prefer the model's stored per-horizon change %; if absent, derive it
      // from the horizon price and the live quote so the column never goes
      // blank when only the predicted price column was populated.
      let predictedChangePctHorizon: number | null = enrich?.predicted_change_pct_horizon ?? null;
      if (
        predictedChangePctHorizon == null &&
        enrich?.predicted_price_horizon != null &&
        currentPrice != null &&
        currentPrice > 0
      ) {
        predictedChangePctHorizon = ((enrich.predicted_price_horizon - currentPrice) / currentPrice) * 100;
      }

      return {
        symbol: q.symbol,
        name: q.longName || q.shortName || q.symbol,
        price: currentPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        gps_score: enrich?.gps_score ?? null,
        gps_breakdown: enrich?.gps_breakdown ?? null,
        gps_as_of: enrich?.as_of ?? null,
        predictedPriceHorizon: enrich?.predicted_price_horizon ?? null,
        predictedChangePctHorizon,
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
      horizonLabel,
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
