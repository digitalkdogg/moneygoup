import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { executeRawQuery } from '@/utils/databaseHelper'
import { checkOrigin } from '@/utils/originCheck'
import { createLogger } from '@/utils/logger'
import { tickerSchema } from '@/utils/validationSchemas'
import { unauthorizedResponse } from '@/utils/errorResponse'
import { checkApprovalGuard } from '@/utils/approvalStatus'
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper'
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy'
import { adjustGpsForHorizon, type GpsBreakdown } from '@/utils/gps'

const logger = createLogger('api/stock_data/[ticker]/gps')

const EMPTY = { gpsScore: null, gpsBreakdown: null, source: 'none' as const, asOf: null, gpsHorizon: null }

const CONSENSUS_POINTS: Record<string, number> = {
  strongBuy: 9, strong_buy: 9, buy: 7, hold: 4, underperform: 2, sell: 0,
}

function parseBreakdown(val: unknown): object | null {
  if (!val) return null
  if (typeof val === 'string') {
    try { return JSON.parse(val) } catch { return null }
  }
  if (typeof val === 'object') return val as object
  return null
}

// For breakdowns produced before GPS v3.0 (missing technicalSignal/analystConsensus),
// enrich with a freshly fetched recommendationKey so the modal can display the consensus row.
function enrichBreakdown(breakdown: object | null, recommendationKey: string | null): object | null {
  if (!breakdown) return breakdown
  const b = breakdown as Record<string, unknown>
  if (b.analystConsensus !== undefined) return breakdown
  const pts = recommendationKey ? (CONSENSUS_POINTS[recommendationKey] ?? CONSENSUS_POINTS.hold) : CONSENSUS_POINTS.hold
  return { ...b, analystConsensus: pts }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const originCheck = checkOrigin(request)
  if (originCheck) return originCheck

  const { ticker: rawTicker } = await params
  const parsed = tickerSchema.safeParse(rawTicker)
  if (!parsed.success) return NextResponse.json(EMPTY)

  const ticker = parsed.data
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return unauthorizedResponse()

  const approvalOutcome = await checkApprovalGuard(session.user.id)
  if (!approvalOutcome.allowed) {
    return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 })
  }

  // Fetch recommendationKey from Yahoo Finance alongside DB lookup
  const [dbResult, analystData] = await Promise.all([
    (async () => {
      try {
        const [sgsRows] = await executeRawQuery(
          `SELECT sgs.gps_score, sgs.gps_breakdown, sgs.as_of
           FROM stock_gps_scores sgs
           JOIN stocks s ON s.id = sgs.stock_id
           WHERE s.symbol = ?`,
          [ticker]
        )
        const sgsRow = (sgsRows as Record<string, unknown>[])[0]
        if (sgsRow?.gps_score != null) {
          return {
            gpsScore: parseFloat(String(sgsRow.gps_score)),
            gpsBreakdown: parseBreakdown(sgsRow.gps_breakdown),
            source: 'stock_gps_scores' as const,
            asOf: sgsRow.as_of ? new Date(String(sgsRow.as_of)).toISOString() : null,
          }
        }

        const [rsRows] = await executeRawQuery(
          `SELECT gps_score, gps_breakdown, created_at
           FROM recommended_stocks
           WHERE ticker = ? AND gps_score IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [ticker]
        )
        const rsRow = (rsRows as Record<string, unknown>[])[0]
        if (rsRow?.gps_score != null) {
          return {
            gpsScore: parseFloat(String(rsRow.gps_score)),
            gpsBreakdown: parseBreakdown(rsRow.gps_breakdown),
            source: 'recommended_stocks' as const,
            asOf: rsRow.created_at ? new Date(String(rsRow.created_at)).toISOString() : null,
          }
        }
        return null
      } catch (err) {
        logger.error('GPS DB lookup failed', { ticker, error: err instanceof Error ? err.message : String(err) })
        return null
      }
    })(),
    fetchYahooStockSummary(ticker).catch(() => null),
  ])

  if (!dbResult) return NextResponse.json(EMPTY)

  const recommendationKey = (analystData as Record<string, Record<string, unknown>> | null)
    ?.financialData?.recommendationKey as string | null ?? null

  const enrichedBreakdown = enrichBreakdown(dbResult.gpsBreakdown, recommendationKey)

  // Patch the score + breakdown using the user's per-horizon prediction the
  // same way the dashboard recommendations route does, so the detail page and
  // the card never disagree. Falls back to the raw stock_gps_scores baseline
  // when no per-user prediction exists (e.g. a ticker the user doesn't own
  // and isn't watching).
  let gpsScore = dbResult.gpsScore
  let gpsBreakdown = enrichedBreakdown
  // Resolved unconditionally (not just inside the try block below) so the
  // response always reports which horizon the score reflects — including
  // when adjustment is skipped or fails, in which case gpsScore/gpsBreakdown
  // fall back to the 1-month baseline and the label should say so.
  const userStrategy = await getUserStrategy(session.user.id).catch(() => DEFAULT_STRATEGY)
  let gpsHorizon: typeof userStrategy.investment_timeframe = '1_month'

  if (enrichedBreakdown) {
    try {
      const sfx = resolveStrategy(userStrategy).timeframe.predictedPriceColumn.replace('predicted_price_', '')
      // Pull the per-horizon change%, the per-horizon confidence, AND the
      // per-horizon predicted_price (with a 1m fallback inside SQL). The
      // dashboard route reads exactly these three so the adjustment math
      // can use the same fallbacks.
      const [uspRows] = await executeRawQuery(
        `SELECT
            usp.predicted_change_pct_${sfx}                              AS change_pct,
            usp.confidence_score_${sfx}                                  AS confidence,
            COALESCE(usp.predicted_price_${sfx}, usp.predicted_price_1m) AS predicted_price
         FROM user_stock_predictions usp
         JOIN stocks s ON s.id = usp.stock_id
         WHERE usp.user_id = ? AND s.symbol = ?
         LIMIT 1`,
        [session.user.id, ticker]
      )
      const uspRow = (uspRows as Record<string, unknown>[])[0]
      const storedChangePct = uspRow?.change_pct != null ? parseFloat(String(uspRow.change_pct)) : null
      const confidence = uspRow?.confidence != null ? parseFloat(String(uspRow.confidence)) : undefined
      const predictedPrice = uspRow?.predicted_price != null ? parseFloat(String(uspRow.predicted_price)) : null

      // Match dashboard fallback exactly: prefer the stored per-horizon
      // change%; otherwise derive from (predictedPrice - currentPrice) /
      // currentPrice. currentPrice from Yahoo financialData when available.
      const currentPrice = (analystData as Record<string, Record<string, unknown>> | null)
        ?.financialData?.currentPrice as number | null ?? null
      const derivedChangePct = (predictedPrice != null && currentPrice != null && currentPrice > 0)
        ? ((predictedPrice - currentPrice) / currentPrice) * 100
        : null
      const changePct = storedChangePct != null ? storedChangePct : derivedChangePct

      if (changePct != null && Number.isFinite(changePct)) {
        const adjusted = adjustGpsForHorizon(enrichedBreakdown as GpsBreakdown, changePct, confidence, userStrategy.investment_timeframe)
        gpsScore = adjusted.score
        gpsBreakdown = adjusted.breakdown
        gpsHorizon = userStrategy.investment_timeframe
      }
    } catch (err) {
      logger.warn('Horizon adjustment failed, returning baseline score', { ticker, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return NextResponse.json({
    ...dbResult,
    gpsScore,
    gpsBreakdown,
    gpsHorizon,
  })
}
