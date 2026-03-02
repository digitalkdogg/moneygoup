/**
 * Rate limiting middleware utilities
 * Provides helpers to apply rate limiting to API routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter } from './rateLimiter';
import { createLogger } from './logger';

const logger = createLogger('utils/rateLimitMiddleware');

/**
 * Extract client IP from request securely.
 * Trusts proxy headers (X-Forwarded-For, X-Real-IP) only if the direct 
 * request source is in the TRUSTED_PROXIES list.
 * 
 * @param request - NextRequest object
 * @returns Client IP address or default '127.0.0.1'
 */
export function getClientIP(request: NextRequest): string {
  const trustedProxiesString = process.env.TRUSTED_PROXIES || '';
  const trustedProxies = new Set(trustedProxiesString.split(',').map(ip => ip.trim()).filter(Boolean));

  // In Next.js/Vercel, request.ip is generally reliable as it's set by the platform.
  // However, if we're behind a custom proxy, we need to be careful.
  const directIP = request.ip || (request as any).socket?.remoteAddress || '127.0.0.1';

  // If we have a list of trusted proxies, only use forwarding headers if directIP is trusted.
  // If TRUSTED_PROXIES is empty, we assume we are not behind a proxy we control and 
  // only trust headers if specifically configured to do so (risk of spoofing).
  const isTrustedProxy = trustedProxies.has(directIP);

  if (isTrustedProxy || trustedProxies.size === 0) {
    // X-Forwarded-For (can be comma-separated list: client, proxy1, proxy2)
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
      const clientIP = forwardedFor.split(',')[0].trim();
      // Basic validation that it's an IP
      if (clientIP && clientIP !== 'unknown') return clientIP;
    }

    // X-Real-IP (from reverse proxy)
    const realIP = request.headers.get('x-real-ip');
    if (realIP) return realIP.split(',')[0].trim();

    // CF-Connecting-IP (from Cloudflare)
    const cfIP = request.headers.get('cf-connecting-ip');
    if (cfIP) return cfIP;
  } else {
    // Direct IP is not a trusted proxy, so forwarding headers might be spoofed.
    // Log suspicious activity if headers are present but untrusted.
    if (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip')) {
      logger.warn('Untrusted proxy headers detected', {
        directIP,
        forwardedFor: request.headers.get('x-forwarded-for'),
        realIP: request.headers.get('x-real-ip')
      });
    }
  }

  return directIP;
}

/**
 * Check rate limit and return response if exceeded
 * If rate limit is exceeded, returns a 429 Too Many Requests response
 * Otherwise returns null (pass through)
 *
 * @param request - NextRequest object
 * @param limiter - RateLimiter instance
 * @param keyPrefix - Optional prefix for rate limit key (default: client IP)
 * @param secondaryId - Optional secondary identifier (e.g., username, email)
 * @returns NextResponse (429) if limited, null if allowed
 */
export function checkRateLimit(
  request: NextRequest,
  limiter: RateLimiter,
  keyPrefix?: string,
  secondaryId?: string
): NextResponse | null {
  const ip = getClientIP(request);
  
  // Use IP + secondaryId if available to prevent bypass by IP rotation
  // for authenticated or identifiable actions.
  let key = keyPrefix ? `${keyPrefix}:${ip}` : ip;
  if (secondaryId) {
    key = `${key}:${secondaryId}`;
  }

  const { allowed, remaining, resetInMs } = limiter.check(key);

  if (!allowed) {
    logger.info('Rate limit exceeded', { key, ip, secondaryId, keyPrefix });
    return NextResponse.json(
      { message: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(resetInMs / 1000)),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Date.now() + resetInMs),
        },
      }
    );
  }

  return null;
}

/**
 * Wrapper function to add rate limiting to an API route handler
 * Usage:
 * export const GET = withRateLimit(stockDataLimiter, async (request, ctx) => {
 *   // handler implementation
 * });
 *
 * @param limiter - RateLimiter instance
 * @param keyPrefix - Optional prefix for rate limit key
 * @param handler - Async request handler
 * @returns Wrapped handler with rate limiting
 */
export function withRateLimit(
  limiter: RateLimiter,
  keyPrefix: string | undefined,
  handler: (request: NextRequest, ctx?: any) => Promise<NextResponse>
) {
  return async (request: NextRequest, ctx?: any): Promise<NextResponse> => {
    const rateLimitResponse = checkRateLimit(request, limiter, keyPrefix);
    if (rateLimitResponse) return rateLimitResponse;

    return handler(request, ctx);
  };
}
