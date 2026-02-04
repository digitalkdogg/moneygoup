import { createLogger } from '@/utils/logger';
import { NextResponse } from 'next/server';
import { secCompanyCache, stockDataCache, technicalIndicatorsCache } from '@/utils/cache';
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import

const logger = createLogger('api/cache-stats');

/**
 * Cache Statistics Endpoint
 * Returns information about current cache usage and expiration times
 * Useful for monitoring and debugging cache behavior
 */
export async function GET() {
  // Add authentication check
  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  // Add authorization check (placeholder for admin role, currently denies all)
  return new NextResponse(JSON.stringify({ message: 'Forbidden: This action requires administrative privileges.' }), { status: 403 });


}

/**
 * Clear all caches
 * Useful for maintenance or resetting stale data
 */
export async function DELETE() {
  // Add authentication check
  const session = await getServerSession(authOptions);
  if (!session || !session.user || !session.user.id) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  // Add authorization check (placeholder for admin role, currently denies all)
  return new NextResponse(JSON.stringify({ message: 'Forbidden: This action requires administrative privileges.' }), { status: 403 });


}
