import { createLogger } from '@/utils/logger';
import { NextResponse, NextRequest } from 'next/server';
import {
  secCompanyCache,
  stockDataCache,
  technicalIndicatorsCache,
  predictionCache,
  deepmoneyCache,
  macroCache,
} from '@/utils/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { isInternalRequest } from '@/utils/internalAuth';
import { unauthorizedResponse } from '@/utils/errorResponse';

const logger = createLogger('api/cache-stats');

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) return originCheckResponse;

  const isInternal = isInternalRequest(request);
  if (!isInternal) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return unauthorizedResponse();
  }

  logger.info('Cache stats requested');

  return NextResponse.json({
    prediction: predictionCache.getStats(),
    stockData: stockDataCache.getStats(),
    technicalIndicators: technicalIndicatorsCache.getStats(),
    secCompany: secCompanyCache.getStats(),
    deepmoney: deepmoneyCache.getStats(),
    macro: macroCache.getStats(),
  });
}

export async function DELETE(request: NextRequest) {
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) return originCheckResponse;

  const isInternal = isInternalRequest(request);
  if (!isInternal) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return unauthorizedResponse();
  }

  predictionCache.clear();
  stockDataCache.clear();
  technicalIndicatorsCache.clear();
  deepmoneyCache.clear();
  macroCache.clear();

  logger.info('All caches cleared');
  return NextResponse.json({ cleared: true });
}
