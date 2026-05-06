// Simple in-memory rate limiter for preview contact submissions
// Tracks IP addresses and their submission timestamps

interface RateLimitEntry {
  count: number;
  firstRequestTime: number;
  lastRequestTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Configuration
const MAX_SUBMISSIONS_PER_HOUR = 5;
const TIME_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Cleanup old entries every hour to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  const keysToDelete: string[] = [];

  rateLimitMap.forEach((entry, ip) => {
    if (now - entry.lastRequestTime > TIME_WINDOW_MS) {
      keysToDelete.push(ip);
    }
  });

  keysToDelete.forEach(ip => rateLimitMap.delete(ip));
}, CLEANUP_INTERVAL_MS);

export function checkRateLimitPreview(ipAddress: string): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  let entry = rateLimitMap.get(ipAddress);

  // If entry doesn't exist or time window has expired, create new entry
  if (!entry || now - entry.firstRequestTime > TIME_WINDOW_MS) {
    entry = {
      count: 1,
      firstRequestTime: now,
      lastRequestTime: now,
    };
    rateLimitMap.set(ipAddress, entry);
    return {
      allowed: true,
      remaining: MAX_SUBMISSIONS_PER_HOUR - 1,
      resetTime: now + TIME_WINDOW_MS,
    };
  }

  // Increment count
  entry.count++;
  entry.lastRequestTime = now;

  const allowed = entry.count <= MAX_SUBMISSIONS_PER_HOUR;
  const remaining = Math.max(0, MAX_SUBMISSIONS_PER_HOUR - entry.count);
  const resetTime = entry.firstRequestTime + TIME_WINDOW_MS;

  return {
    allowed,
    remaining,
    resetTime,
  };
}

export function getRateLimitInfo(ipAddress: string): { count: number; remaining: number; resetTime: number } | null {
  const entry = rateLimitMap.get(ipAddress);
  if (!entry) {
    return null;
  }

  const remaining = Math.max(0, MAX_SUBMISSIONS_PER_HOUR - entry.count);
  const resetTime = entry.firstRequestTime + TIME_WINDOW_MS;

  return {
    count: entry.count,
    remaining,
    resetTime,
  };
}
