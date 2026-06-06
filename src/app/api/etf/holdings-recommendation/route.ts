import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { isInternalRequest } from '@/utils/internalAuth';
import { createLogger } from '@/utils/logger';
import { unauthorizedResponse, createErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';

const logger = createLogger('api/etf/holdings-recommendation');

// GET — return unseen ETF holdings recommendations for the current user
export async function GET(request: NextRequest) {
  const originCheck = checkOrigin(request);
  if (originCheck) return originCheck;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return unauthorizedResponse();

  const approvalOutcome = await checkApprovalGuard(session.user.id);
  if (!approvalOutcome.allowed) {
    return NextResponse.json(
      { message: approvalOutcome.message, code: approvalOutcome.code },
      { status: 403 }
    );
  }

  const unseenOnly = request.nextUrl.searchParams.get('unseen') === 'true';

  try {
    const [rows] = await executeRawQuery(
      `SELECT id, etf_ticker, stock_ticker, gps_score, predicted_change_pct,
              confidence_score, recommendation_reason, seen, snapshot_date, created_at
       FROM etf_stock_recommendations
       WHERE user_id = ?
         ${unseenOnly ? 'AND seen = 0' : ''}
       ORDER BY gps_score DESC, created_at DESC
       LIMIT 50`,
      [session.user.id]
    );

    const recommendations = (rows as any[]).map(r => ({
      id: r.id,
      etfTicker: r.etf_ticker,
      stockTicker: r.stock_ticker,
      gpsScore: r.gps_score != null ? parseFloat(r.gps_score) : null,
      predictedChangePct: r.predicted_change_pct != null ? parseFloat(r.predicted_change_pct) : null,
      confidenceScore: r.confidence_score != null ? parseFloat(r.confidence_score) : null,
      recommendationReason: r.recommendation_reason,
      seen: !!r.seen,
      snapshotDate: r.snapshot_date,
      createdAt: r.created_at,
    }));

    return NextResponse.json({ recommendations });
  } catch (err) {
    logger.error('GET etf/holdings-recommendation failed', { error: err });
    return createErrorResponse(err, 'Failed to fetch ETF holdings recommendations');
  }
}

// POST — save a new recommendation (internal sync script only)
export async function POST(request: NextRequest) {
  // Internal calls (x-api-key) bypass CSRF origin check — they have no browser Origin header
  if (!isInternalRequest(request)) {
    const originCheck = checkOrigin(request);
    if (originCheck) return originCheck;
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const { user_id, etf_ticker, stock_ticker, gps_score, predicted_change_pct, confidence_score, source } = body;

    if (!user_id || !etf_ticker || !stock_ticker) {
      return NextResponse.json({ message: 'user_id, etf_ticker, stock_ticker required' }, { status: 400 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const reason = source === 'etf_holdings_scan'
      ? `${stock_ticker} is a top holding of ${etf_ticker} with GPS ${gps_score?.toFixed(1)} and +${predicted_change_pct?.toFixed(1)}% predicted gain.`
      : null;

    await executeRawQuery(
      `INSERT INTO etf_stock_recommendations
         (user_id, etf_ticker, stock_ticker, gps_score, predicted_change_pct,
          confidence_score, recommendation_reason, snapshot_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         gps_score            = VALUES(gps_score),
         predicted_change_pct = VALUES(predicted_change_pct),
         confidence_score     = VALUES(confidence_score),
         recommendation_reason = VALUES(recommendation_reason),
         seen                 = 0`,
      [user_id, etf_ticker.toUpperCase(), stock_ticker.toUpperCase(),
       gps_score ?? null, predicted_change_pct ?? null, confidence_score ?? null,
       reason, today]
    );

    logger.info('ETF holdings recommendation saved', { user_id, etf_ticker, stock_ticker, gps_score });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('POST etf/holdings-recommendation failed', { error: err });
    return createErrorResponse(err, 'Failed to save ETF holdings recommendation');
  }
}

// PATCH — mark recommendations as seen (dismiss)
export async function PATCH(request: NextRequest) {
  const originCheck = checkOrigin(request);
  if (originCheck) return originCheck;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return unauthorizedResponse();

  try {
    const body = await request.json();
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ message: 'ids array required' }, { status: 400 });
    }

    const placeholders = ids.map(() => '?').join(', ');
    await executeRawQuery(
      `UPDATE etf_stock_recommendations SET seen = 1
       WHERE id IN (${placeholders}) AND user_id = ?`,
      [...ids, session.user.id]
    );

    return NextResponse.json({ ok: true, dismissed: ids.length });
  } catch (err) {
    logger.error('PATCH etf/holdings-recommendation failed', { error: err });
    return createErrorResponse(err, 'Failed to dismiss recommendations');
  }
}
