import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { executeRawQuery } from '@/utils/databaseHelper'
import { checkOrigin } from '@/utils/originCheck'
import { createLogger } from '@/utils/logger'
import { tickerSchema } from '@/utils/validationSchemas'

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
  { params }: { params: { ticker: string } }
) {
  const originCheck = checkOrigin(request)
  if (originCheck) return originCheck

  const parsed = tickerSchema.safeParse(params.ticker)
  if (!parsed.success) return NextResponse.json(EMPTY)

  const ticker = parsed.data
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id

  try {
    if (userId) {
      const [rows] = await executeRawQuery(
        `SELECT usp.gps_score, usp.gps_breakdown, usp.last_requested_at
         FROM user_stock_predictions usp
         JOIN stocks s ON s.id = usp.stock_id
         WHERE usp.user_id = ? AND s.symbol = ?
         ORDER BY usp.last_requested_at DESC
         LIMIT 1`,
        [userId, ticker]
      )
      const row = (rows as any[])[0]
      if (row?.gps_score != null) {
        return NextResponse.json({
          gpsScore: parseFloat(row.gps_score),
          gpsBreakdown: parseBreakdown(row.gps_breakdown),
          source: 'user_stock_predictions' as const,
          asOf: row.last_requested_at ? new Date(row.last_requested_at).toISOString() : null,
        })
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
