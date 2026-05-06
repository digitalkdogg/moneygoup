import { executeRawQuery } from './databaseHelper';
import { createLogger } from './logger';

const logger = createLogger('preview-visit-logger');

// Simple in-memory deduplication to avoid logging same IP multiple times in quick succession
interface VisitRecord {
  ip: string;
  lastVisitTime: number;
}

const recentVisits = new Map<string, VisitRecord>();
const DEDUP_WINDOW_MS = 60 * 1000; // 1 minute - don't log same IP twice within 1 min

// For testing: reset the dedup cache
export function __resetRecentVisits() {
  recentVisits.clear();
}

// Cleanup old dedupe records every 5 minutes
setInterval(() => {
  const now = Date.now();
  const keysToDelete: string[] = [];

  recentVisits.forEach((record, ip) => {
    if (now - record.lastVisitTime > DEDUP_WINDOW_MS) {
      keysToDelete.push(ip);
    }
  });

  keysToDelete.forEach(ip => recentVisits.delete(ip));
}, 5 * 60 * 1000);

export interface PreviewVisitData {
  ipAddress: string;
  userAgent: string | null;
  timestamp?: Date;
}

/**
 * Extract IP address from request headers
 * Handles proxies and load balancers
 */
export function extractIpAddress(
  xForwardedFor?: string | null,
  xRealIp?: string | null,
  fallback?: string
): string {
  // x-forwarded-for can contain multiple IPs: "client, proxy1, proxy2"
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0);
    if (ips.length > 0) {
      return ips[0];
    }
  }

  // Fallback to x-real-ip (nginx)
  if (xRealIp) {
    const trimmedRealIp = xRealIp.trim();
    if (trimmedRealIp.length > 0) {
      return trimmedRealIp;
    }
  }

  // Final fallback
  return fallback || 'unknown';
}

/**
 * Get current UTC timestamp
 */
export function getCurrentUtcTimestamp(): Date {
  return new Date(Date.now());
}

/**
 * Check if we should log this visit (deduplication)
 */
export function shouldLogVisit(ipAddress: string): boolean {
  const now = Date.now();
  const existing = recentVisits.get(ipAddress);

  if (!existing) {
    updateDedupRecord(ipAddress);
    return true;
  }

  // If more than DEDUP_WINDOW_MS has passed, allow logging
  if (now - existing.lastVisitTime > DEDUP_WINDOW_MS) {
    updateDedupRecord(ipAddress);
    return true;
  }

  return false;
}

/**
 * Update the dedup record for an IP
 */
function updateDedupRecord(ipAddress: string): void {
  recentVisits.set(ipAddress, {
    ip: ipAddress,
    lastVisitTime: Date.now(),
  });
}

/**
 * Log a preview page visit
 * Non-blocking: returns a promise but doesn't require awaiting
 */
export async function logPreviewVisit(data: PreviewVisitData): Promise<boolean> {
  const { ipAddress, userAgent, timestamp } = data;

  try {
    // Validate IP address
    if (!ipAddress || ipAddress === 'unknown' || ipAddress.trim().length === 0) {
      logger.warn('Invalid IP address for preview visit logging', { ip: ipAddress });
      return false;
    }

    // Check deduplication
    if (!shouldLogVisit(ipAddress)) {
      logger.info('Skipping duplicate preview visit', { ip: ipAddress });
      return false;
    }

    // Sanitize inputs
    const sanitizedIp = ipAddress.trim().slice(0, 64);
    const sanitizedUserAgent = userAgent ? userAgent.trim().slice(0, 500) : null;
    const visitTimestamp = timestamp || getCurrentUtcTimestamp();

    // Insert into database
    const [result] = await executeRawQuery(
      'INSERT INTO preview_visits (ip_address, user_agent, visited_at) VALUES (?, ?, ?)',
      [sanitizedIp, sanitizedUserAgent, visitTimestamp]
    );

    logger.info('Preview visit logged successfully', {
      ip: sanitizedIp,
      timestamp: visitTimestamp.toISOString(),
    });

    return true;
  } catch (error: unknown) {
    // Log error but don't throw - visits are non-critical analytics
    logger.error('Failed to log preview visit', {
      error: error instanceof Error ? error.message : String(error),
      ip: ipAddress,
    });
    return false;
  }
}

/**
 * Get visit statistics (for analytics dashboard)
 */
export async function getPreviewVisitStats(
  timeWindow: 'today' | 'week' | 'month' = 'week'
): Promise<{
  totalVisits: number;
  uniqueIps: number;
  topIps: Array<{ ip: string; count: number }>;
} | null> {
  try {
    const now = new Date();
    let startDate: Date;

    switch (timeWindow) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
    }

    // Total visits
    const [totalResult] = await executeRawQuery(
      'SELECT COUNT(*) as count FROM preview_visits WHERE visited_at >= ?',
      [startDate]
    );

    const totalVisits = (Array.isArray(totalResult) && totalResult[0])
      ? (totalResult[0] as any).count
      : 0;

    // Unique IPs
    const [uniqueResult] = await executeRawQuery(
      'SELECT COUNT(DISTINCT ip_address) as count FROM preview_visits WHERE visited_at >= ?',
      [startDate]
    );

    const uniqueIps = (Array.isArray(uniqueResult) && uniqueResult[0])
      ? (uniqueResult[0] as any).count
      : 0;

    // Top IPs
    const [topResult] = await executeRawQuery(
      'SELECT ip_address as ip, COUNT(*) as count FROM preview_visits WHERE visited_at >= ? GROUP BY ip_address ORDER BY count DESC LIMIT 10',
      [startDate]
    );

    const topIps = Array.isArray(topResult)
      ? topResult.map((row: any) => ({ ip: row.ip, count: row.count }))
      : [];

    return { totalVisits, uniqueIps, topIps };
  } catch (error: unknown) {
    logger.error('Failed to get preview visit stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
