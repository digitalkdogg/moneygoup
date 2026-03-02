import { NextResponse, NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse, forbiddenResponse } from '@/utils/errorResponse';
import { performDeepAnalysis } from './analysis';
import { deepmoneyCache } from '@/utils/cache';
import { deepmoneyLimiter } from '@/utils/rateLimiter';
import { getClientIP } from '@/utils/rateLimitMiddleware';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/deepmoney');

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) return originCheckResponse;

  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  
  let callerId = 'unknown';
  let authMode = 'none';

  // 1. Authorization Split
  const isInternal = apiKey && apiKey === internalSecret;
  
  if (isInternal) {
    callerId = 'internal-automation';
    authMode = 'api-key';
  } else {
    const session = await getServerSession(authOptions);
    if (!session) return unauthorizedResponse('Authentication required');
    
    // RBAC: Only admin or premium users can trigger heavy analysis
    // Note: session.user.role needs to be populated in NextAuth callbacks
    const userRole = (session.user as any).role || 'user';
    if (userRole !== 'admin' && userRole !== 'premium') {
      return forbiddenResponse('Premium subscription required for deep analysis');
    }
    
    callerId = session.user.email || session.user.id || 'authenticated-user';
    authMode = 'session';

    // 2. Per-user Rate Limiting (2 per hour)
    const ip = getClientIP(request);
    const { allowed, resetInMs } = deepmoneyLimiter.check(`${callerId}:${ip}`);
    if (!allowed) {
      return NextResponse.json(
        { message: `Analysis limit exceeded. Try again in ${Math.ceil(resetInMs / 60000)} minutes.` },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(resetInMs / 1000)) } }
      );
    }
  }

  // 3. Caching (Global 30-minute window)
  const cacheKey = 'global_deep_analysis';
  const cachedResult = deepmoneyCache.get(cacheKey);
  if (cachedResult) {
    logger.info('DeepMoney analysis cache hit', { callerId, authMode });
    return NextResponse.json(cachedResult);
  }

  // 4. Execution & Audit Logging
  const startTime = Date.now();
  try {
    logger.info('Starting DeepMoney analysis', { callerId, authMode });
    
    const analysis = await performDeepAnalysis();
    
    const duration = Date.now() - startTime;
    logger.info('DeepMoney analysis completed', { 
      callerId, 
      authMode, 
      durationMs: duration,
      status: 'success'
    });

    // Store in cache
    deepmoneyCache.set(cacheKey, analysis);
    
    return NextResponse.json(analysis);

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('DeepMoney analysis failed', { 
      callerId, 
      authMode, 
      durationMs: duration,
      error: error instanceof Error ? error.message : String(error)
    });
    return createErrorResponse(error, 'Failed to perform deep analysis.', { status: 500 });
  }
}
