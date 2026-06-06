import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { isInternalRequest } from '@/utils/internalAuth';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';
import { unauthorizedResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { fetchETFHoldings } from '@/utils/etfHoldings';

const logger = createLogger('api/stock_data/[ticker]/holdings');

function getEnvFloat(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (!val) return defaultVal;
  const n = parseFloat(val);
  return isNaN(n) ? defaultVal : n;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const originCheck = checkOrigin(request);
  if (originCheck) return originCheck;

  const { ticker: rawTicker } = await params;
  const parsed = tickerSchema.safeParse(rawTicker?.toUpperCase());
  if (!parsed.success) {
    return NextResponse.json({ ticker: rawTicker, isEtf: false, holdings: [] });
  }
  const ticker = parsed.data;

  // Allow internal sync-script calls (x-api-key) or authenticated browser sessions
  const internal = isInternalRequest(request);
  if (!internal) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return unauthorizedResponse();

    const approvalOutcome = await checkApprovalGuard(session.user.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json(
        { message: approvalOutcome.message, code: approvalOutcome.code },
        { status: 403 }
      );
    }
  }

  try {
    // 1. Fetch raw holdings from Yahoo Finance
    const limitParam = request.nextUrl.searchParams.get('limit');
    const limit = Math.min(Math.max(parseInt(limitParam ?? '5', 10) || 5, 1), 20);
    const rawHoldings = await fetchETFHoldings(ticker, limit);

    if (rawHoldings.length === 0) {
      return NextResponse.json({ ticker, isEtf: false, holdings: [] });
    }

    // 2. Enrich with cached scores from etf_holding_scores (most recent snapshot per holding ticker)
    const holdingTickers = rawHoldings.map(h => h.ticker);
    const placeholders = holdingTickers.map(() => '?').join(', ');

    let scoreRows: any[] = [];
    try {
      const [rows] = await executeRawQuery(
        `SELECT ehs.ticker, ehs.gps_score, ehs.gps_breakdown,
                ehs.predicted_change_pct, ehs.bearish_signal, ehs.beta,
                ehs.score_source, ehs.snapshot_date
         FROM etf_holding_scores ehs
         INNER JOIN (
           SELECT ticker, MAX(snapshot_date) AS max_date
           FROM etf_holding_scores
           WHERE ticker IN (${placeholders}) AND parent_etf_ticker = ?
           GROUP BY ticker
         ) latest ON ehs.ticker = latest.ticker AND ehs.snapshot_date = latest.max_date
         WHERE ehs.parent_etf_ticker = ?`,
        [...holdingTickers, ticker, ticker]
      );
      scoreRows = rows as any[];
    } catch (err) {
      logger.warn('etf_holding_scores lookup failed, returning raw holdings', { ticker, error: err });
    }

    // Build a map for quick lookup
    const scoreMap = new Map<string, any>();
    for (const row of scoreRows) {
      scoreMap.set(row.ticker.toUpperCase(), row);
    }

    // 3. Surfacing thresholds (same constants as scoreETFHoldings)
    const gpsSurfaceValue  = getEnvFloat('ETF_HOLDING_GPS_SURFACE_VALUE', 60);
    const maxBeta          = getEnvFloat('ETF_HOLDING_MAX_BETA', 2.0);
    const minPredChangePct = getEnvFloat('ETF_HOLDING_MIN_PRED_CHANGE', 1.5);

    // 4. Merge holdings with scores
    const holdings = rawHoldings.map(h => {
      const cached = scoreMap.get(h.ticker.toUpperCase());

      let gps_score: number | null = null;
      let gps_breakdown: object | null = null;
      let predicted_change_pct: number | null = null;
      let bearish_signal: boolean | null = null;
      let beta: number | null = null;
      let score_source: string | null = null;
      let surfaced = false;

      if (cached) {
        gps_score = cached.gps_score != null ? parseFloat(cached.gps_score) : null;
        predicted_change_pct = cached.predicted_change_pct != null ? parseFloat(cached.predicted_change_pct) : null;
        bearish_signal = !!cached.bearish_signal;
        beta = cached.beta != null ? parseFloat(cached.beta) : null;
        score_source = cached.score_source ?? null;

        if (cached.gps_breakdown) {
          try {
            gps_breakdown = typeof cached.gps_breakdown === 'string'
              ? JSON.parse(cached.gps_breakdown)
              : cached.gps_breakdown;
          } catch {}
        }

        if (
          gps_score !== null &&
          predicted_change_pct !== null &&
          gps_score >= gpsSurfaceValue &&
          predicted_change_pct >= minPredChangePct &&
          !bearish_signal &&
          (beta === null || beta <= maxBeta)
        ) {
          surfaced = true;
        }
      }

      return {
        ticker: h.ticker,
        companyName: h.companyName,
        holdingPercent: h.holdingPercent,
        gps_score,
        gps_breakdown,
        score_source,
        surfaced,
      };
    });

    logger.info(`Holdings fetched for ${ticker}`, {
      count: holdings.length,
      surfacedCount: holdings.filter(h => h.surfaced).length,
    });

    return NextResponse.json({ ticker, isEtf: true, holdings });
  } catch (err) {
    logger.error('Error fetching ETF holdings', {
      ticker,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ticker, isEtf: false, holdings: [] });
  }
}
