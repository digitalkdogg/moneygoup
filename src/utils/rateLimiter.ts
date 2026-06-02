// src/utils/rateLimiter.ts
import { RedisRateLimiter } from './redisRateLimiter';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitOptions {
  /** Max requests allowed within the window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor({ limit, windowMs }: RateLimitOptions) {
    this.limit = limit;
    this.windowMs = windowMs;

    // Purge stale entries every 10 minutes.
    // .unref() prevents this timer from keeping the process alive.
    const timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      // New window
      this.store.set(key, { count: 1, windowStart: now });
      return {
        allowed: true,
        remaining: this.limit - 1,
        resetInMs: this.windowMs,
      };
    }

    if (entry.count < this.limit) {
      entry.count++;
      return {
        allowed: true,
        remaining: this.limit - entry.count,
        resetInMs: this.windowMs - (now - entry.windowStart),
      };
    }

    // Limit exceeded
    return {
      allowed: false,
      remaining: 0,
      resetInMs: this.windowMs - (now - entry.windowStart),
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.windowStart >= this.windowMs) {
        this.store.delete(key);
      }
    }
  }
}

// ── Singleton instances ────────────────────────────────────────
// Redis-backed so counters are shared across all workers/containers.

/** 5 registration attempts per IP per 15 minutes */
export const registerLimiter = new RedisRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });

/** 10 login attempts per IP per 15 minutes */
export const loginLimiter = new RedisRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });

/** 5 prediction attempts per user per minute */
export const predictionLimiter = new RedisRateLimiter({ limit: 5, windowMs: 60 * 1000 });

/** 30 requests per IP per minute for stock data endpoints */
export const stockDataLimiter = new RedisRateLimiter({ limit: 30, windowMs: 60 * 1000 });

/** 20 requests per IP per minute for news endpoints */
export const newsLimiter = new RedisRateLimiter({ limit: 20, windowMs: 60 * 1000 });

/** 15 requests per IP per minute for quote endpoints */
export const quoteLimiter = new RedisRateLimiter({ limit: 15, windowMs: 60 * 1000 });

/** 10 requests per IP per minute for historical data endpoints */
export const historicalLimiter = new RedisRateLimiter({ limit: 10, windowMs: 60 * 1000 });

/** 2 heavy analysis requests per hour per user/IP */
export const deepmoneyLimiter = new RedisRateLimiter({ limit: 2, windowMs: 60 * 60 * 1000 });

/** 3 forgot-password requests per IP per 15 minutes */
export const forgotPasswordLimiter = new RedisRateLimiter({ limit: 3, windowMs: 15 * 60 * 1000 });

/** 5 reset-password attempts per IP per 15 minutes */
export const resetPasswordLimiter = new RedisRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });

/** 3 contact form submissions per IP per hour */
export const contactLimiter = new RedisRateLimiter({ limit: 3, windowMs: 60 * 60 * 1000 });

/** 5 unsubscribe attempts per IP per 15 minutes */
export const unsubscribeLimiter = new RedisRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });

/** 100 admin panel requests per IP per 15 minutes */
export const adminLimiter = new RedisRateLimiter({ limit: 100, windowMs: 15 * 60 * 1000 });
