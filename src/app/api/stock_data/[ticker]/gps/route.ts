import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { executeRawQuery } from '@/utils/databaseHelper'
import { checkOrigin } from '@/utils/originCheck'
import { createLogger } from '@/utils/logger'
import { tickerSchema } from '@/utils/validationSchemas'
import { unauthorizedResponse } from '@/utils/errorResponse'
import { checkApprovalGuard } from '@/utils/approvalStatus'

const logger = createLogger('api/stock_data/[ticker]/gps')

const EMPTY = { gpsScore: null, gpsBreakdown: null, source: 'none' as const, asOf: null }

function parseBreakdown(val: unknown): object | null {
  if (!val) return null
  if (typeof val === 'string') {
    try { return JSON.parse(val) } catch { return null }
  }
  if (typeof val === 'object') return val as object
  return null
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

  try {
    const [sgsRows] = await executeRawQuery(
      `SELECT sgs.gps_score, sgs.gps_breakdown, sgs.as_of
       FROM stock_gps_scores sgs
       JOIN stocks s ON s.id = sgs.stock_id
       WHERE s.symbol = ?`,
      [ticker]
    )
    const sgsRow = (sgsRows as any[])[0]
    if (sgsRow?.gps_score != null) {
      return NextResponse.json({
        gpsScore: parseFloat(sgsRow.gps_score),
        gpsBreakdown: parseBreakdown(sgsRow.gps_breakdown),
        source: 'stock_gps_scores' as const,
        asOf: sgsRow.as_of ? new Date(sgsRow.as_of).toISOString() : null,
      })
    }

    const [rsRows] = await executeRawQuery(
      `SELECT gps_score, gps_breakdown, created_at
       FROM recommended_stocks
       WHERE ticker = ? AND gps_score IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [ticker]
    )
    const rsRow = (rsRows as any[])[0]
    if (rsRow?.gps_score != null) {
      return NextResponse.json({
        gpsScore: parseFloat(rsRow.gps_score),
        gpsBreakdown: parseBreakdown(rsRow.gps_breakdown),
        source: 'recommended_stocks' as const,
        asOf: rsRow.created_at ? new Date(rsRow.created_at).toISOString() : null,
      })
    }

    return NextResponse.json(EMPTY)
  } catch (err) {
    logger.error('GPS lookup failed', { ticker, error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(EMPTY)
  }
}
