/**
 * Rate limiting middleware utilities
 * Provides helpers to apply rate limiting to API routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter } from './rateLimiter';

/**
 * Extract client IP from request
 * Checks multiple headers in order of preference:
 * - X-Real-IP (from reverse proxy)
 * - X-Forwarded-For (from load balancer)
 * - CF-Connecting-IP (from Cloudflare)
 * - socket.remoteAddress (from socket)
 *
 * @param request - NextRequest object
 * @returns Client IP address or default '127.0.0.1'
 */
export function getClientIP(request: NextRequest): string {
  // Try X-Real-IP first (single IP)
  const realIP = request.headers.get('x-real-ip');
  if (realIP) return realIP.split(',')[0].trim();

  // Try X-Forwarded-For (can be comma-separated list)
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();

  // Try Cloudflare header
  const cfIP = request.headers.get('cf-connecting-ip');
  if (cfIP) return cfIP;

  // Fallback - try to get from socket (not always available in serverless)
  const ip = (request as any).socket?.remoteAddress;
  if (ip) return ip;

  // Default fallback
  return '127.0.0.1';
}

/**
 * Check rate limit and return response if exceeded
 * If rate limit is exceeded, returns a 429 Too Many Requests response
 * Otherwise returns null (pass through)
 *
 * @param request - NextRequest object
 * @param limiter - RateLimiter instance
 * @param keyPrefix - Optional prefix for rate limit key (default: client IP)
 * @returns NextResponse (429) if limited, null if allowed
 */
export function checkRateLimit(
  request: NextRequest,
  limiter: RateLimiter,
  keyPrefix?: string
): NextResponse | null {
  const ip = getClientIP(request);
  const key = keyPrefix ? `${keyPrefix}:${ip}` : ip;

  const { allowed, remaining, resetInMs } = limiter.check(key);

  if (!allowed) {
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
