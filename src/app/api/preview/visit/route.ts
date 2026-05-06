import { NextRequest, NextResponse } from 'next/server';
import { logPreviewVisit, extractIpAddress } from '@/utils/previewVisitLogger';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/preview/visit');

/**
 * POST /api/preview/visit
 * Log a preview page visit
 * Non-blocking endpoint - returns immediately without waiting for DB insert
 */
export async function POST(request: NextRequest) {
  try {
    // Extract IP address from headers
    const xForwardedFor = request.headers.get('x-forwarded-for');
    const xRealIp = request.headers.get('x-real-ip');
    const ipAddress = extractIpAddress(xForwardedFor, xRealIp);

    // Get user agent
    const userAgent = request.headers.get('user-agent');

    // Log visit asynchronously (fire and forget)
    // Don't await - return immediately for non-blocking behavior
    logPreviewVisit({
      ipAddress,
      userAgent,
    }).catch(error => {
      logger.error('Unhandled error in visit logging', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Return immediately - don't wait for DB insert
    return NextResponse.json(
      { logged: true },
      { status: 202 } // 202 Accepted - request received but not yet processed
    );
  } catch (error: unknown) {
    // Even if something fails, don't disrupt the page
    logger.error('Error in visit logging endpoint', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Return 202 anyway - we logged the attempt
    return NextResponse.json(
      { logged: false },
      { status: 202 }
    );
  }
}
