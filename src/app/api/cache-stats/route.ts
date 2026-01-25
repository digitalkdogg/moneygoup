import { NextResponse } from 'next/server';
import { secCompanyCache, stockDataCache, technicalIndicatorsCache } from '@/utils/cache';

/**
 * Cache Statistics Endpoint
 * Returns information about current cache usage and expiration times
 * Useful for monitoring and debugging cache behavior
 */
export async function GET() {
  try {
    const stats = {
      secCompanyCache: secCompanyCache.getStats(),
      stockDataCache: stockDataCache.getStats(),
      technicalIndicatorsCache: technicalIndicatorsCache.getStats(),
      timestamp: new Date().toISOString(),
      totalCachedItems:
        secCompanyCache.size() + stockDataCache.size() + technicalIndicatorsCache.size()
    };

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error fetching cache stats:', error);
    return NextResponse.json({ error: 'Failed to retrieve cache statistics' }, { status: 500 });
  }
}

/**
 * Clear all caches
 * Useful for maintenance or resetting stale data
 */
export async function DELETE() {
  try {
    secCompanyCache.clear();
    stockDataCache.clear();
    technicalIndicatorsCache.clear();

    return NextResponse.json({
      message: 'All caches cleared successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error clearing caches:', error);
    return NextResponse.json({ error: 'Failed to clear caches' }, { status: 500 });
  }
}
