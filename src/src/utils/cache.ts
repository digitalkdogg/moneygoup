/**
 * TTL-based in-memory cache utility
 * Automatically expires entries based on TTL
 * Prevents memory leaks from unbounded cache growth
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class Cache<T> {
  private store: Map<string, CacheEntry<T>> = new Map();
  private defaultTtlMs: number;

  constructor(defaultTtlMs: number = 3600000) {
    // Default: 1 hour
    this.defaultTtlMs = defaultTtlMs;

    // Clean up expired entries every 5 minutes
    setInterval(() => this.cleanup(), 300000);
  }

  /**
   * Get a value from cache
   * Returns null if key doesn't exist or has expired
   */
  get(key: string): T | null {
    const entry = this.store.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set a value in cache with optional TTL
   */
  set(key: string, data: T, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs || this.defaultTtlMs);
    this.store.set(key, { data, expiresAt });
  }

  /**
   * Check if key exists and hasn't expired
   */
  has(key: string): boolean {
    const entry = this.store.get(key);

    if (!entry) {
      return false;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific key from cache
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Clear all entries from cache
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get cache size (number of entries)
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Remove all expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      console.log(`Cache cleanup: removed ${expiredCount} expired entries`);
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): {
    size: number;
    entries: Array<{ key: string; expiresIn: number }>;
  } {
    const now = Date.now();
    const entries = Array.from(this.store.entries())
      .filter(([, entry]) => now <= entry.expiresAt)
      .map(([key, entry]) => ({
        key,
        expiresIn: Math.round((entry.expiresAt - now) / 1000) // seconds
      }));

    return {
      size: entries.length,
      entries
    };
  }
}

// Export singleton instances for common cache scenarios
export const secCompanyCache = new Cache<{
  [key: string]: { cik_str: number; ticker: string; title: string };
}>(24 * 60 * 60 * 1000); // 24 hours for SEC data

export const stockDataCache = new Cache<any>(5 * 60 * 1000); // 5 minutes for stock data

export const technicalIndicatorsCache = new Cache<any>(10 * 60 * 1000); // 10 minutes for indicators

export default Cache;
