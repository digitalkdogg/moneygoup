import { createLogger } from '@/utils/logger';
import { NextResponse, NextRequest } from 'next/server';
import { secCompanyCache, stockDataCache, technicalIndicatorsCache } from '@/utils/cache';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import
import { checkOrigin } from '@/utils/originCheck'; // Add this import
import { unauthorizedResponse, forbiddenResponse } from '@/utils/errorResponse'; // Add this import

const logger = createLogger('api/cache-stats');

/**
 * Cache Statistics Endpoint
 * Returns information about current cache usage and expiration times
 * Useful for monitoring and debugging cache behavior
 */
export async function GET(request: NextRequest) { // Add NextRequest type
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  // Add authentication check
  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return unauthorizedResponse();
  }

  // Add authorization check (placeholder for admin role, currently denies all)
  return forbiddenResponse('Forbidden: This action requires administrative privileges.');


}

/**
 * Clear all caches
 * Useful for maintenance or resetting stale data
 */
export async function DELETE(request: NextRequest) { // Add NextRequest type
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  // Add authentication check
  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return unauthorizedResponse();
  }

  // Add authorization check (placeholder for admin role, currently denies all)
  return forbiddenResponse('Forbidden: This action requires administrative privileges.');


}
