import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

redis.on('error', (err) => {
  console.error('[RedisRateLimiter] Connection error:', err.message);
});

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export class RedisRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;

  constructor({ limit, windowMs }: { limit: number; windowMs: number }) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  async check(key: string): Promise<RateLimitResult> {
    const windowSec = Math.ceil(this.windowMs / 1000);
    const redisKey  = `rl:${key}`;

    // INCR is atomic; if key is new, set its TTL immediately after.
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSec);
    }

    const ttlSec = await redis.ttl(redisKey);
    const resetInMs = ttlSec > 0 ? ttlSec * 1000 : this.windowMs;

    if (count > this.limit) {
      return { allowed: false, remaining: 0, resetInMs };
    }

    return {
      allowed: true,
      remaining: this.limit - count,
      resetInMs,
    };
  }
}
