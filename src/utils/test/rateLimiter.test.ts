import { RateLimiter } from '../rateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    jest.useFakeTimers();
    limiter = new RateLimiter({ limit: 3, windowMs: 1000 }); // 3 requests per second
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('allows requests within limit', () => {
    expect(limiter.check('key1').allowed).toBe(true);
    expect(limiter.check('key1').allowed).toBe(true);
    expect(limiter.check('key1').allowed).toBe(true);
    expect(limiter.check('key1').allowed).toBe(false);
  });

  test('tracks different keys separately', () => {
    limiter.check('key1');
    limiter.check('key1');
    limiter.check('key1');
    expect(limiter.check('key1').allowed).toBe(false);
    expect(limiter.check('key2').allowed).toBe(true);
  });

  test('resets after window duration', () => {
    limiter.check('key1');
    limiter.check('key1');
    limiter.check('key1');
    expect(limiter.check('key1').allowed).toBe(false);

    jest.advanceTimersByTime(1001);

    expect(limiter.check('key1').allowed).toBe(true);
  });

  test('returns correct remaining and resetInMs', () => {
    const res1 = limiter.check('key1');
    expect(res1.remaining).toBe(2);
    expect(res1.resetInMs).toBe(1000);

    jest.advanceTimersByTime(500);

    const res2 = limiter.check('key1');
    expect(res2.remaining).toBe(1);
    expect(res2.resetInMs).toBe(500);
  });
});
