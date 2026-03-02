import { NextRequest } from 'next/server';
import { checkOrigin } from '../originCheck';

describe('originCheck', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const createMockRequest = (method: string, origin?: string, referer?: string) => {
    const headers = new Headers();
    if (origin) headers.set('origin', origin);
    if (referer) headers.set('referer', referer);
    return {
      method,
      headers,
    } as unknown as NextRequest;
  };

  test('returns 500 if ALLOWED_ORIGINS is not set', () => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.NEXTAUTH_URL;
    const req = createMockRequest('GET');
    const res = checkOrigin(req);
    expect(res?.status).toBe(500);
  });

  test('allows requests from allowed origin', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://example.com';
    const req = createMockRequest('POST', 'http://example.com');
    const res = checkOrigin(req);
    expect(res).toBeNull();
  });

  test('blocks requests from unauthorized origin', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
    const req = createMockRequest('POST', 'http://evil.com');
    const res = checkOrigin(req);
    expect(res?.status).toBe(401);
  });

  test('blocks mutating requests without origin and referer', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
    const req = createMockRequest('POST'); // No origin/referer
    const res = checkOrigin(req);
    expect(res?.status).toBe(403);
  });

  test('allows mutating requests with valid referer if origin is missing', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
    const req = createMockRequest('POST', undefined, 'http://localhost:3000/some-page');
    const res = checkOrigin(req);
    expect(res).toBeNull();
  });
});
