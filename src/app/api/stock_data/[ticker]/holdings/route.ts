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
import { resolveEtfHoldingAlgorithm } from '@/utils/etfHoldingPreset';

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

    // 2. Look up the score for each holding from `stock_gps_scores` — the
    //    canonical "every analyzer-scored ticker's current GPS" table. This
    //    replaces the deprecated `etf_holding_scores` cache, which was only
    //    populated by scoreETFHoldings() (now disabled for the deepmoney
    //    discovery path) and went stale immediately. stock_gps_scores is
    //    refreshed every sync run for every stock the analyzer touches —
    //    holdings included, since holding tickers flow through the main
    //    analyzer pipeline via enrichTickers + analyzeStocks.
    const holdingTickers = rawHoldings.map(h => h.ticker.toUpperCase());
    const placeholders = holdingTickers.map(() => '?').join(', ');

    let scoreRows: any[] = [];
    try {
      const [rows] = await executeRawQuery(
        `SELECT s.symbol AS ticker, sgs.gps_score, sgs.gps_breakdown, sgs.source AS score_source
         FROM stocks s
         INNER JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
         WHERE s.symbol IN (${placeholders})`,
        holdingTickers
      );
      scoreRows = rows as any[];
    } catch (err) {
      logger.warn('stock_gps_scores lookup failed, returning raw holdings', { ticker, error: err });
    }

    const scoreMap = new Map<string, any>();
    for (const row of scoreRows) {
      scoreMap.set(row.ticker.toUpperCase(), row);
    }

    // 3. Surfacing thresholds, derived from the same ETF_HOLDING_ALGORITHM
    //    knob used during scoring so this route agrees with whatever level
    //    produced the cached scores.
    const etfAlgorithm     = resolveEtfHoldingAlgorithm(process.env.ETF_HOLDING_ALGORITHM);
    const gpsSurfaceValue  = etfAlgorithm.gpsSurfaceValue;
    const minPredChangePct = etfAlgorithm.minPredChangePct;

    // The breakdown's `mlpUpside` component is computed as:
    //   clip(predicted_change_pct / GPS_PREDICTION_MAX, -1, 1) * 20
    // GPS_PREDICTION_MAX defaults to 3 (see src/utils/gps.ts:72,95). So
    //   mlpUpside ≥ minPredChangePct / 3 * 20 ⟺ predicted_change_pct ≥ minPredChangePct
    // We use this inverse to recover a predicted_change_pct proxy and a
    // bearish flag (mlpUpside < 0 means the model predicted a decline) from
    // the JSON breakdown — no separate columns needed.
    const predictionMax = getEnvFloat('GPS_PREDICTION_MAX', 3);
    const minMlpUpsideForSurface = (minPredChangePct / predictionMax) * 20;

    // 4. Merge holdings with scores
    const holdings = rawHoldings.map(h => {
      const cached = scoreMap.get(h.ticker.toUpperCase());

      let gps_score: number | null = null;
      let gps_breakdown: any = null;
      let predicted_change_pct: number | null = null;
      let bearish_signal: boolean | null = null;
      const beta: number | null = null;  // no longer sourced; kept in response shape
      let score_source: string | null = null;
      let surfaced = false;

      if (cached) {
        gps_score = cached.gps_score != null ? parseFloat(cached.gps_score) : null;
        score_source = cached.score_source ?? null;

        if (cached.gps_breakdown) {
          try {
            gps_breakdown = typeof cached.gps_breakdown === 'string'
              ? JSON.parse(cached.gps_breakdown)
              : cached.gps_breakdown;
          } catch {}
        }

        const mlpUpside = gps_breakdown && typeof gps_breakdown.mlpUpside === 'number'
          ? gps_breakdown.mlpUpside
          : null;

        // Recover predicted_change_pct + bearish_signal from the breakdown
        // so the response shape is unchanged for existing consumers.
        if (mlpUpside !== null) {
          predicted_change_pct = (mlpUpside / 20) * predictionMax;
          bearish_signal = mlpUpside < 0;
        }

        if (
          gps_score !== null &&
          gps_score >= gpsSurfaceValue &&
          mlpUpside !== null &&
          mlpUpside >= minMlpUpsideForSurface
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
        predicted_change_pct,
        bearish_signal,
        beta,
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
