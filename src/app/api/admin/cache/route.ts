import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { unauthorizedResponse, forbiddenResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { adminLimiter } from '@/utils/rateLimiter';
import { readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import {
  secCompanyCache,
  stockDataCache,
  historicalDataCache,
  technicalIndicatorsCache,
  deepmoneyCache,
  macroCache,
  marketIndicesCache,
  analystRatingsCache,
  worldBankCache,
  earningsCache,
  analystDataCache,
  newsDataCache,
  predictionCache,
} from '@/utils/cache';
import { dataCache as stockDataPayloadCache } from '@/app/api/stock_data/[ticker]/data/route';

const logger = createLogger('api/admin/cache');

// Adapter so the raw Map from the /data route behaves like a Cache instance.
const DATA_CACHE_TTL_MS = 15 * 60 * 1000;
const stockDataPayloadCacheAdapter = {
  getStats() {
    const now = Date.now();
    const entries = Array.from(stockDataPayloadCache.entries())
      .filter(([, v]) => now - v.fetchedAt < DATA_CACHE_TTL_MS)
      .map(([key, v]) => ({ key, expiresIn: Math.round((DATA_CACHE_TTL_MS - (now - v.fetchedAt)) / 1000) }));
    return { size: entries.length, entries };
  },
  clear() { stockDataPayloadCache.clear(); },
};

const CACHES = {
  stockDataPayload: { cache: stockDataPayloadCacheAdapter, label: 'Stock Data Payload (/data)', ttlMin: 15 },
  prediction: { cache: predictionCache, label: 'Predictions', ttlMin: 15 },
  stockData: { cache: stockDataCache, label: 'Stock Data', ttlMin: 15 },
  historicalData: { cache: historicalDataCache, label: 'Historical Data', ttlMin: 15 },
  technicalIndicators: { cache: technicalIndicatorsCache, label: 'Technical Indicators', ttlMin: 10 },
  deepmoney: { cache: deepmoneyCache, label: 'Deep Money', ttlMin: 30 },
  macro: { cache: macroCache, label: 'Macro', ttlMin: 1440 },
  marketIndices: { cache: marketIndicesCache, label: 'Market Indices', ttlMin: 2 },
  analystRatings: { cache: analystRatingsCache, label: 'Analyst Ratings', ttlMin: 30 },
  worldBank: { cache: worldBankCache, label: 'World Bank', ttlMin: 360 },
  earnings: { cache: earningsCache, label: 'Earnings', ttlMin: 720 },
  analystData: { cache: analystDataCache, label: 'Analyst Data', ttlMin: 360 },
  newsData: { cache: newsDataCache, label: 'News Data', ttlMin: 120 },
  secCompany: { cache: secCompanyCache, label: 'SEC Company', ttlMin: 1440 },
} as const;

type CacheKey = keyof typeof CACHES;

// The window used by latest-prediction to serve cached DB rows.
const DB_CACHE_WINDOW_HOURS = 12;

// File-based disk cache written by predict_core.py inside the prediction service.
const DISK_CACHE_DIR = join(process.cwd(), 'scripts', 'prediction_cache');

function getDiskCacheStats() {
  try {
    const files = readdirSync(DISK_CACHE_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const pklFiles  = files.filter(f => f.endsWith('.pkl'));
    let totalBytes = 0;
    for (const f of files) {
      try { totalBytes += statSync(join(DISK_CACHE_DIR, f)).size; } catch {}
    }
    // Build per-ticker entries sorted by mtime descending (most recently cached first).
    const tickerEntries = pklFiles.map(f => {
      const ticker = f.replace('_features_df.pkl', '');
      let mtime = 0;
      let size = 0;
      try { const s = statSync(join(DISK_CACHE_DIR, f)); mtime = s.mtimeMs; size = s.size; } catch {}
      return { ticker, mtime, size };
    }).sort((a, b) => b.mtime - a.mtime);

    const tickers = tickerEntries.map(e => e.ticker);
    return { jsonCount: jsonFiles.length, pklCount: pklFiles.length, totalBytes, tickers, tickerEntries };
  } catch {
    return { jsonCount: 0, pklCount: 0, totalBytes: 0, tickers: [], tickerEntries: [] };
  }
}

function clearDiskCacheFiles(ext: 'json' | 'pkl' | 'all', ticker?: string) {
  try {
    const files = readdirSync(DISK_CACHE_DIR);
    let deleted = 0;
    for (const f of files) {
      const shouldDelete =
        ticker
          ? f === `${ticker}_features_df.pkl`
          : ext === 'all' || f.endsWith(`.${ext}`);
      if (shouldDelete) {
        try { unlinkSync(join(DISK_CACHE_DIR, f)); deleted++; } catch {}
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}

function currentModelVersion(): string {
  const useLegacy = process.env.USE_LEGACY_PREDICTION_MODEL === 'true';
  const csVersion = process.env.CS_MODEL_VERSION || 'v2';
  return useLegacy ? 'legacy' : `v3split_${csVersion}`;
}

async function verifyAdmin(request: NextRequest): Promise<{ userId?: number; error?: NextResponse }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { error: unauthorizedResponse() };

  const [rows] = await executeRawQuery('SELECT role FROM users WHERE id = ?', [session.user.id]);
  const role = (Array.isArray(rows) && rows.length > 0) ? (rows[0] as any).role : null;
  if (role !== 'admin') {
    logger.warn('Cache admin endpoint attempted by non-admin', { userId: session.user.id, role });
    return { error: forbiddenResponse('Admin access required') };
  }
  return { userId: Number(session.user.id) };
}

async function getDbPredictionStats() {
  const modelVersion = currentModelVersion();
  const [rows] = await executeRawQuery(
    `SELECT symbol, created_at
     FROM prediction_records
     WHERE model_version = ?
       AND created_at >= NOW() - INTERVAL ? HOUR
     ORDER BY created_at DESC`,
    [modelVersion, DB_CACHE_WINDOW_HOURS]
  );

  const entries = (rows as Array<{ symbol: string; created_at: string }>).map((r) => {
    const createdAt = new Date(r.created_at);
    return {
      symbol: r.symbol,
      createdAt: createdAt.toISOString(),
      ageMinutes: Math.round((Date.now() - createdAt.getTime()) / 60000),
    };
  });

  return { modelVersion, windowHours: DB_CACHE_WINDOW_HOURS, count: entries.length, entries };
}

export async function GET(request: NextRequest) {
  const originCheck = checkOrigin(request);
  if (originCheck) return originCheck;

  const rateLimit = await checkRateLimit(request, adminLimiter, 'admin');
  if (rateLimit) return rateLimit;

  const auth = await verifyAdmin(request);
  if (auth.error) return auth.error;

  const caches: Record<string, { label: string; ttlMin: number; size: number; entries: Array<{ key: string; expiresIn: number }> }> = {};
  for (const [key, { cache, label, ttlMin }] of Object.entries(CACHES)) {
    caches[key] = { label, ttlMin, ...cache.getStats() };
  }

  const dbPredictions = await getDbPredictionStats();
  const diskCache = getDiskCacheStats();

  return NextResponse.json({ caches, dbPredictions, diskCache });
}

export async function DELETE(request: NextRequest) {
  const originCheck = checkOrigin(request);
  if (originCheck) return originCheck;

  const rateLimit = await checkRateLimit(request, adminLimiter, 'admin');
  if (rateLimit) return rateLimit;

  const auth = await verifyAdmin(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const target = searchParams.get('cache') ?? 'all';
  const ticker = searchParams.get('ticker')?.toUpperCase().trim() ?? null;

  // Disk cache clears
  if (target === 'disk_predictions') {
    const deleted = clearDiskCacheFiles('json');
    logger.info('Admin cleared disk prediction JSONs', { userId: auth.userId, deleted });
    return NextResponse.json({ cleared: 'disk_predictions', deleted });
  }

  if (target === 'disk_features') {
    const deleted = clearDiskCacheFiles('pkl', ticker ?? undefined);
    logger.info('Admin cleared disk feature caches', { userId: auth.userId, ticker, deleted });
    return NextResponse.json({ cleared: 'disk_features', ticker, deleted });
  }

  if (target === 'disk_all') {
    const deleted = clearDiskCacheFiles('all');
    logger.info('Admin cleared entire disk cache', { userId: auth.userId, deleted });
    return NextResponse.json({ cleared: 'disk_all', deleted });
  }

  // DB prediction cache clear
  if (target === 'db_predictions') {
    const modelVersion = currentModelVersion();
    if (ticker) {
      await executeRawQuery(
        `DELETE FROM prediction_records
         WHERE symbol = ?
           AND model_version = ?
           AND created_at >= NOW() - INTERVAL ? HOUR`,
        [ticker, modelVersion, DB_CACHE_WINDOW_HOURS]
      );
      logger.info('Admin cleared DB prediction cache for ticker', { userId: auth.userId, ticker, modelVersion });
      return NextResponse.json({ cleared: 'db_predictions', ticker });
    }

    await executeRawQuery(
      `DELETE FROM prediction_records
       WHERE model_version = ?
         AND created_at >= NOW() - INTERVAL ? HOUR`,
      [modelVersion, DB_CACHE_WINDOW_HOURS]
    );
    logger.info('Admin cleared all active DB prediction cache', { userId: auth.userId, modelVersion });
    return NextResponse.json({ cleared: 'db_predictions' });
  }

  // Clear everything: in-memory + DB + disk
  if (target === 'all') {
    for (const { cache } of Object.values(CACHES)) {
      cache.clear();
    }
    const modelVersion = currentModelVersion();
    await executeRawQuery(
      `DELETE FROM prediction_records
       WHERE model_version = ?
         AND created_at >= NOW() - INTERVAL ? HOUR`,
      [modelVersion, DB_CACHE_WINDOW_HOURS]
    );
    clearDiskCacheFiles('all');
    logger.info('Admin cleared all caches (memory + DB + disk)', { userId: auth.userId });
    return NextResponse.json({ cleared: 'all' });
  }

  // Clear all caches for a specific ticker
  if (target === 'ticker') {
    if (!ticker) return NextResponse.json({ message: 'ticker param required' }, { status: 400 });

    // In-memory caches
    let memoryDeleted = 0;
    for (const { cache } of Object.values(CACHES)) {
      if ('clearByTicker' in cache) {
        memoryDeleted += (cache as any).clearByTicker(ticker);
      }
    }
    // stockDataPayload Map (the /data route cache)
    stockDataPayloadCache.delete(ticker);

    // DB prediction records
    const modelVersion = currentModelVersion();
    await executeRawQuery(
      `DELETE FROM prediction_records
       WHERE symbol = ?
         AND model_version = ?
         AND created_at >= NOW() - INTERVAL ? HOUR`,
      [ticker, modelVersion, DB_CACHE_WINDOW_HOURS]
    );

    // Python disk PKL
    const diskDeleted = clearDiskCacheFiles('pkl', ticker);

    logger.info('Admin cleared all caches for ticker', { userId: auth.userId, ticker, memoryDeleted, diskDeleted });
    return NextResponse.json({ cleared: 'ticker', ticker, memoryDeleted, diskDeleted });
  }

  if (!(target in CACHES)) {
    return NextResponse.json({ message: 'Unknown cache name' }, { status: 400 });
  }

  CACHES[target as CacheKey].cache.clear();
  logger.info('Admin cleared cache', { userId: auth.userId, cache: target });
  return NextResponse.json({ cleared: target });
}
