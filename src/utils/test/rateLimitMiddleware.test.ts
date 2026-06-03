import { NextRequest } from 'next/server';
import { getClientIP, checkRateLimit } from '../rateLimitMiddleware';
import { RateLimiter } from '../rateLimiter';

describe('rateLimitMiddleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getClientIP', () => {
    test('uses request.ip if available', () => {
      const req = { ip: '1.2.3.4', headers: new Headers() } as unknown as NextRequest;
      expect(getClientIP(req)).toBe('1.2.3.4');
    });

    test('uses x-forwarded-for if direct IP is trusted', () => {
      process.env.TRUSTED_PROXIES = '127.0.0.1';
      const headers = new Headers();
      headers.set('x-forwarded-for', '10.0.0.1, 127.0.0.1');
      const req = { ip: '127.0.0.1', headers } as unknown as NextRequest;
      expect(getClientIP(req)).toBe('10.0.0.1');
    });

    test('ignores x-forwarded-for if direct IP is NOT trusted', () => {
      process.env.TRUSTED_PROXIES = '192.168.1.1';
      const headers = new Headers();
      headers.set('x-forwarded-for', '10.0.0.1');
      const req = { ip: '127.0.0.1', headers } as unknown as NextRequest;
      expect(getClientIP(req)).toBe('127.0.0.1');
    });
  });

  describe('checkRateLimit', () => {
    let mockLimiter: RateLimiter;

    beforeEach(() => {
      mockLimiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    });

    test('allows first request, blocks second', async () => {
      const req = { ip: '1.1.1.1', headers: new Headers() } as unknown as NextRequest;
      expect(await checkRateLimit(req, mockLimiter as any)).toBeNull();
      const res = await checkRateLimit(req, mockLimiter as any);
      expect(res?.status).toBe(429);
    });

    test('uses secondaryId in key if provided', async () => {
      const req = { ip: '1.1.1.1', headers: new Headers() } as unknown as NextRequest;
      // First request with user1: allowed
      expect(await checkRateLimit(req, mockLimiter as any, 'prefix', 'user1')).toBeNull();
      // Second request with same user1: blocked
      expect((await checkRateLimit(req, mockLimiter as any, 'prefix', 'user1'))?.status).toBe(429);
      // Request with different user2 (same IP): allowed
      expect(await checkRateLimit(req, mockLimiter as any, 'prefix', 'user2')).toBeNull();
    });
  });
});
