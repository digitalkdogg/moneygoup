import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';
import { DashboardRecommendation, DashboardRecommendationsResponse } from '@/types/dashboard';
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy';
import { adjustGpsForHorizon } from '@/utils/gps';

const logger = createLogger('api/dashboard/recommendations');

async function fetchMacroContext(): Promise<Record<string, unknown> | null> {
    try {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
        const res = await fetch(`${baseUrl}/api/worldbank`, {
            headers: { 'x-api-key': internalSecret || '' }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        logger.warn('Failed to fetch macro context for recommendations', { error: err });
        return null;
    }
}

function getEnvThreshold(key: string, fallback: number): number {
  const val = process.env[key]
  if (!val) return fallback
  const parsed = parseFloat(val)
  return isNaN(parsed) ? fallback : parsed
}

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session) return unauthorizedResponse();

  try {
    const userId = session.user?.id;
    if (!userId) return unauthorizedResponse('Unauthorized: User ID missing from session.');

    const approvalOutcome = await checkApprovalGuard(userId);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }

    // Resolve user's current strategy (defaults to neutral / 1_month when no row).
    const userStrategy = await getUserStrategy(userId).catch(() => DEFAULT_STRATEGY);

    // Pick the predicted_price column based on the user's timeframe; fall back
    // to predicted_price_1m so behavior is graceful when other horizons aren't
    // populated yet. predictedPriceColumn comes from a controlled enum — safe
    // to interpolate into SQL.
    const timeframeConfig = resolveStrategy(userStrategy).timeframe;
    const priceColumn = timeframeConfig.predictedPriceColumn;
    const sfx = priceColumn.replace('predicted_price_', ''); // '1w' | '1m' | '6m' | '1y'
    const horizonLabel = timeframeConfig.shortLabel;

    // 1. Fetch predictions with GPS scores. GPS is strategy-independent — we
    // always read the canonical value from stock_gps_scores (with a fallback
    // to the recommended_stocks snapshot).
    const [rows] = await executeRawQuery(`
      SELECT
        usp.stock_id,
        s.symbol,
        COALESCE(usp.${priceColumn}, usp.predicted_price_1m) as predicted_price,
        usp.predicted_price_1m,
        usp.predicted_change_pct_${sfx} AS predicted_change_pct_horizon,
        usp.confidence_score_${sfx} AS confidence_score_horizon,
        COALESCE(sgs.gps_score, rs.gps_score) as gps_score,
        COALESCE(sgs.gps_breakdown, rs.gps_breakdown) as gps_breakdown,
        usp.last_requested_at,
        us.is_purchased,
        us.user_confirmed,
        us.shares,
        us.is_active
      FROM user_stock_predictions usp
      JOIN stocks s ON s.id = usp.stock_id
      JOIN user_stocks us
        ON us.user_id = usp.user_id
       AND us.stock_id = usp.stock_id
      LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = usp.stock_id
      LEFT JOIN (
        SELECT ticker, MAX(gps_score) as gps_score, MAX(gps_breakdown) as gps_breakdown
        FROM recommended_stocks
        GROUP BY ticker
      ) rs ON s.symbol = rs.ticker
      WHERE usp.user_id = ? AND us.is_active = 1
      ORDER BY usp.last_requested_at DESC;
    `, [userId]);

    const predictions = rows as Record<string, unknown>[];

    // 1b. Fetch ETF holding recommendations from the latest snapshot only.
    // Mirrors the deepmoney-picks pattern: rows accumulate across update_predictions.py
    // runs, but we only ever surface the most recent one to avoid mixing stale picks
    // from prior days with the current set.
    //
    // LEFT JOIN to stock_gps_scores so the "View score" modal can render the full
    // 8-component breakdown. update_predictions.py writes the breakdown to
    // stock_gps_scores for every holding via save_gps_score_to_db; without this
    // join the modal sees null and renders the empty-state branch.
    // Also pull the user's per-horizon change% + confidence for each holding
    // when they exist in user_stock_predictions (the user owns/watches the
    // holding directly). If not, the LEFT JOIN returns NULL and we keep the
    // raw baseline GPS — same fallback the dashboard already uses elsewhere.
    const [etfRecRows] = await executeRawQuery(
      `SELECT esr.stock_ticker, esr.etf_ticker, esr.gps_score, esr.predicted_change_pct,
              esr.confidence_score, esr.created_at, sgs.gps_breakdown,
              usp.predicted_change_pct_${sfx} AS holding_change_pct_horizon,
              usp.confidence_score_${sfx}     AS holding_confidence_horizon
       FROM etf_stock_recommendations esr
       LEFT JOIN stocks s ON s.symbol = esr.stock_ticker
       LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
       LEFT JOIN user_stock_predictions usp ON usp.stock_id = s.id AND usp.user_id = ?
       WHERE esr.user_id = ?
         AND esr.snapshot_date = (
           SELECT MAX(snapshot_date) FROM etf_stock_recommendations WHERE user_id = ?
         )
       ORDER BY esr.gps_score DESC`,
      [userId, userId, userId]
    );
    const etfRecs = etfRecRows as Record<string, unknown>[];

    if (predictions.length === 0 && etfRecs.length === 0) {
      return NextResponse.json({ recommendations: [], asOf: new Date().toISOString() });
    }

    // 2. Fetch current prices in batch — include ETF holding tickers so cards show live price
    const predSymbols = predictions.map(p => p.symbol as string);
    const etfHoldingSymbols = [...new Set(etfRecs.map(r => r.stock_ticker as string))];
    const allSymbols = [...new Set([...predSymbols, ...etfHoldingSymbols])];
    const stockIdMap = new Map<string, number>(predictions.map(p => [p.symbol as string, p.stock_id as number]));
    const quotes = await fetchYahooQuotesForSymbols(allSymbols, stockIdMap);
    const quoteMap = new Map<number, Record<string, unknown>>();
    const symbolPriceMap = new Map<string, number>();
    quotes.forEach(q => {
      if (q.stock_id !== null) quoteMap.set(q.stock_id as number, q as Record<string, unknown>);
      if (q.symbol && q.price !== null) symbolPriceMap.set(q.symbol as string, q.price as number);
    });

    // 3. GPS thresholds — env defaults, then scaled by the user's strategy multiplier.
    // safe (1.05) raises the bar; aggressive (0.95) lowers it. Sell is intentionally
    // not multiplied — users should still be warned about underperformers regardless
    // of aggressiveness. predChangeGate is the strategy's own absolute value (already
    // varies with aggressiveness: safe=3%, neutral=1.5%, aggressive=0.5%).
    const { gates: strategyGates } = resolveStrategy(userStrategy);
    const mult = strategyGates.envFloorMultiplier;

    // BUY/SELL/DISCOVERY thresholds are one baseline + two offsets. BUY anchors
    // the system ("a stock is buy-worthy when GPS clears baseline"); SELL and
    // DISCOVERY are relative to that. Offsets are typically negative — SELL is
    // a lower bar to warn on underperformers, DISCOVERY is a lower bar to
    // surface promising-but-unconfirmed picks.
    const envBuyThreshold       = getEnvThreshold('GPS_BASELINE', 65);
    const envSellThreshold      = envBuyThreshold + getEnvThreshold('GPS_SELL_OFFSET', -20);
    const envDiscoveryThreshold = envBuyThreshold + getEnvThreshold('GPS_DISCOVERY_OFFSET', 5);

    // Timeframe stacks on top of aggressiveness: it multiplies the predicted-change
    // bar (longer horizon → bigger expected move required) and shifts the sell
    // threshold (longer horizon → more tolerant of dips, holds through volatility).
    const buyThreshold       = envBuyThreshold * mult;
    const sellThreshold      = envSellThreshold + timeframeConfig.sellThresholdShift;
    const discoveryThreshold = envDiscoveryThreshold * mult;
    const predChangeGate     = strategyGates.predChangeGate * timeframeConfig.predChangeMultiplier;

    // 4. Macro GPS adjustment (±3 pts max)
    const macroContext = await fetchMacroContext();
    const unemployment = (macroContext?.macro as Record<string, unknown> | undefined)
      ?.indicators as Record<string, unknown> | undefined;
    const unemploymentSignal = (unemployment?.unemployment as Record<string, unknown> | undefined)?.signal as string | undefined;
    const globalHealth = (macroContext?.risk_index as Record<string, unknown> | undefined)
      ?.globalHealthScore as number | undefined;

    let macroGpsAdjustment = 0;
    if (unemploymentSignal === 'bearish') {
      macroGpsAdjustment -= 2;
      logger.info('Applying unemployment macro dampener to GPS scores', { adjustment: -2 });
    }
    if (globalHealth != null) {
      if (globalHealth > 70) macroGpsAdjustment += 1.5;
      else if (globalHealth < 45) macroGpsAdjustment -= 3;
    }
    macroGpsAdjustment = Math.max(-3, Math.min(3, macroGpsAdjustment));

    // 5. Build recommendations
    const recommendations: DashboardRecommendation[] = [];

    for (const pred of predictions) {
      const quote = quoteMap.get(pred.stock_id as number);
      if (!quote || quote.price === null) continue;

      const currentPrice    = quote.price as number;
      // The query aliases the timeframe-specific column to `predicted_price`,
      // falling back to predicted_price_1m. Also keep predicted_price_1m around
      // for the response payload's deprecated `predictedPrice1m` field.
      const predictedPrice  = parseFloat(String(pred.predicted_price ?? pred.predicted_price_1m));
      const predictedPrice1m = parseFloat(String(pred.predicted_price_1m));
      const deltaPct        = ((predictedPrice - currentPrice) / currentPrice) * 100;

      // Patch the cached 1m baseline using the user's timeframe. Prefer the
      // model's persisted per-horizon change% + confidence so the score matches
      // /api/prediction/[ticker] exactly; fall back to the price-derived delta
      // when those columns are NULL (legacy rows).
      const baselineBreakdown = pred.gps_breakdown
        ? (typeof pred.gps_breakdown === 'string' ? JSON.parse(pred.gps_breakdown) : pred.gps_breakdown)
        : null;

      let perUserBreakdown = baselineBreakdown;
      let perUserScore = pred.gps_score != null ? parseFloat(String(pred.gps_score)) : null;
      const storedChangePct = pred.predicted_change_pct_horizon != null ? parseFloat(String(pred.predicted_change_pct_horizon)) : null;
      const storedConfidence = pred.confidence_score_horizon != null ? parseFloat(String(pred.confidence_score_horizon)) : undefined;
      if (baselineBreakdown) {
        const changePct = storedChangePct != null ? storedChangePct : (Number.isFinite(deltaPct) ? deltaPct : null);
        if (changePct != null) {
          const adjusted = adjustGpsForHorizon(baselineBreakdown, changePct, storedConfidence);
          perUserBreakdown = adjusted.breakdown;
          perUserScore = adjusted.score;
        }
      }

      const rawGps       = perUserScore;
      const adjustedGps  = rawGps != null ? rawGps + macroGpsAdjustment : null;

      const isConfirmed  = pred.user_confirmed === 1;
      const isPurchased  = pred.is_purchased === 1;
      const hasShares    = (pred.shares as number) > 0;

      let action: 'BUY' | 'SELL' | null = null;
      let scope: DashboardRecommendation['scope'] | null = null;

      if (adjustedGps === null) continue;

      // Strategy gate: predicted change must clear the user's predChangeGate
      // for any BUY action. Doesn't apply to SELL (we always warn).
      const passesPredGate = deltaPct >= predChangeGate;

      if (isPurchased && isConfirmed && hasShares) {
        scope = 'portfolio';
        if (adjustedGps >= buyThreshold && passesPredGate) action = 'BUY';
        else if (adjustedGps < sellThreshold) action = 'SELL';
      } else if (!isPurchased && isConfirmed) {
        scope = 'watchlist';
        if (adjustedGps >= buyThreshold && passesPredGate) action = 'BUY';
      } else if (!isPurchased && !isConfirmed) {
        scope = 'discovery';
        if (adjustedGps >= discoveryThreshold && passesPredGate) action = 'BUY';
      }

      if (action && scope) {
        recommendations.push({
          stockId:        pred.stock_id as number,
          symbol:         pred.symbol as string,
          action,
          currentPrice,
          predictedPrice1m,
          deltaPct,
          gpsScore:       rawGps,
          gpsBreakdown:   perUserBreakdown,
          gpsHorizon:     userStrategy.investment_timeframe,
          lastRequestedAt: pred.last_requested_at as string,
          scope,
        });
      }
    }

    // 6. Merge ETF holding recommendations — deduplicate against symbols already present
    const existingSymbols = new Set(recommendations.map(r => r.symbol));
    const seenEtfTickers = new Set<string>();
    for (const rec of etfRecs) {
      const symbol = (rec.stock_ticker as string).toUpperCase();
      // Skip if this ticker already has a portfolio/watchlist/discovery card
      if (existingSymbols.has(symbol)) continue;
      // Deduplicate: one card per stock ticker (keep highest GPS, already ordered DESC)
      if (seenEtfTickers.has(symbol)) continue;
      seenEtfTickers.add(symbol);

      const gps = rec.gps_score != null ? parseFloat(String(rec.gps_score)) : null;
      if (gps === null) continue;

      const currentPrice = symbolPriceMap.get(symbol) ?? 0;
      const predChangePct = rec.predicted_change_pct != null ? parseFloat(String(rec.predicted_change_pct)) : 0;
      const predictedPrice1m = currentPrice > 0 ? currentPrice * (1 + predChangePct / 100) : 0;

      // Parse the breakdown JSON pulled in via the stock_gps_scores join.
      // Null for the small set of holdings that haven't been scored yet, or
      // when the join misses (ticker not in the stocks table — auto-inserted
      // on next update_predictions.py run via BR-5.10).
      const rawBreakdown = rec.gps_breakdown;
      const baselineBreakdown = rawBreakdown
        ? (typeof rawBreakdown === 'string' ? JSON.parse(rawBreakdown as string) : rawBreakdown)
        : null;

      // If the user owns/watches this holding directly, user_stock_predictions
      // has a row with per-horizon change% + confidence — same data the
      // portfolio/watchlist code path uses. Adjust the GPS so the ETF holding
      // card shows the user's timeframe view, not the 1m baseline. Falls back
      // to baseline when no per-user prediction exists for the holding.
      let holdingGps = gps;
      let holdingBreakdown = baselineBreakdown;
      if (baselineBreakdown) {
        const holdingStoredChangePct = rec.holding_change_pct_horizon != null
          ? parseFloat(String(rec.holding_change_pct_horizon))
          : null;
        const holdingStoredConfidence = rec.holding_confidence_horizon != null
          ? parseFloat(String(rec.holding_confidence_horizon))
          : undefined;
        // For holdings not in user_stock_predictions, fall back to the
        // esr.predicted_change_pct value the sync persisted at scan time.
        const changePctForAdjust = holdingStoredChangePct != null ? holdingStoredChangePct : predChangePct;
        if (changePctForAdjust != null) {
          const adjusted = adjustGpsForHorizon(baselineBreakdown, changePctForAdjust, holdingStoredConfidence);
          holdingGps = adjusted.score;
          holdingBreakdown = adjusted.breakdown;
        }
      }

      recommendations.push({
        stockId:         0,
        symbol,
        action:          'BUY',
        currentPrice,
        predictedPrice1m,
        deltaPct:        predChangePct,
        gpsScore:        holdingGps,
        gpsBreakdown:    holdingBreakdown,
        lastRequestedAt: rec.created_at as string,
        scope:           'etf_holding',
        etfTicker:       (rec.etf_ticker as string).toUpperCase(),
      });
    }

    // Sort by GPS score descending — strongest signals first
    recommendations.sort((a, b) => (b.gpsScore ?? 0) - (a.gpsScore ?? 0));

    const response: DashboardRecommendationsResponse = {
      recommendations,
      horizonLabel,
      asOf: new Date().toISOString(),
    };

    return NextResponse.json(response);

  } catch (error: unknown) {
    logger.error('Failed to fetch dashboard recommendations.', { error });
    return createErrorResponse(error, 'Failed to fetch recommendations.', { status: 500 });
  }
}
