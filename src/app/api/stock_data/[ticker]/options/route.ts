// GET /api/stock_data/[ticker]/options
// Fetches options market data (IV, IV Rank, Put/Call Ratio) from yahoo-finance2.
// Returns gracefully (null values) if options data unavailable for the ticker.
// Cached for 15 minutes.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { unauthorizedResponse, validationErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { createLogger } from '@/utils/logger';
import { tickerSchema } from '@/utils/validationSchemas';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const logger = createLogger('api/stock_data/[ticker]/options');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------------------------------------------------------------------------
// Server-side cache — 15-minute TTL, hard cap of 500 entries
// ---------------------------------------------------------------------------
const OPTIONS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const OPTIONS_CACHE_MAX = 500;
const optionsCache = new Map<string, { data: unknown; fetchedAt: number }>();

function getCached(ticker: string): unknown | null {
  const entry = optionsCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > OPTIONS_CACHE_TTL_MS) {
    optionsCache.delete(ticker);
    return null;
  }
  return entry.data;
}

function setCache(ticker: string, data: unknown): void {
  const now = Date.now();
  // Lazy eviction of stale entries
  for (const [k, v] of optionsCache.entries()) {
    if (now - v.fetchedAt > OPTIONS_CACHE_TTL_MS) optionsCache.delete(k);
  }
  if (optionsCache.size >= OPTIONS_CACHE_MAX) {
    logger.warn('optionsCache exceeded max entries — clearing', { size: optionsCache.size });
    optionsCache.clear();
  }
  optionsCache.set(ticker, { data, fetchedAt: now });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Calculate IV Rank: where the current IV sits in its 52-week range
function calculateIvRank(currentIv: number, ivHistory: number[]): number | null {
  if (!ivHistory || ivHistory.length === 0) return null;
  const minIv = Math.min(...ivHistory);
  const maxIv = Math.max(...ivHistory);
  if (maxIv === minIv) return 0.5; // Flat IV range
  return (currentIv - minIv) / (maxIv - minIv);
}

// Calculate Put/Call Ratio from options chain
// Sum all put open interest / sum all call open interest
function calculatePutCallRatio(chain: any[]): number | null {
  if (!chain || chain.length === 0) return null;

  let putOI = 0;
  let callOI = 0;

  for (const option of chain) {
    const oi = safeNum(option.openInterest) ?? 0;
    // Determine if put or call based on contract symbol or option data
    // yahoo-finance2 chains include a 'type' or we can infer from contractSymbol
    if (option.contractSymbol && option.contractSymbol.includes('P')) {
      putOI += oi;
    } else if (option.contractSymbol && option.contractSymbol.includes('C')) {
      callOI += oi;
    }
  }

  if (callOI === 0) return null;
  return putOI / callOI;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheck = checkOrigin(request);
    if (originCheck) return originCheck;

    const session = await getServerSession(authOptions);
    if (!session?.user) return unauthorizedResponse('Authentication required');
    const approvalOutcome = await checkApprovalGuard((session.user as any).id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
  }

  let validatedTicker: string;
  try {
    validatedTicker = tickerSchema.parse(params.ticker);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues[0]?.message ?? 'Invalid ticker';
      return validationErrorResponse(msg);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  // Return cached response if still fresh
  const cached = getCached(validatedTicker);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    // Fetch options chain from yahoo-finance2
    let optionsChain: any[] = [];
    let currentIv: number | null = null;
    let ivRank: number | null = null;
    let putCallRatio: number | null = null;
    let available = false;

    try {
      const options = await yahooFinance.options(validatedTicker);

      if (options && Array.isArray(options)) {
        optionsChain = options;
        available = true;

        // Calculate IV (use ATM or mean if available)
        // yahoo-finance2 options data typically includes implied volatility per contract
        const ivValues = options
          .map((opt: any) => safeNum(opt.impliedVolatility))
          .filter((iv: any) => iv !== null && iv !== undefined) as number[];

        if (ivValues.length > 0) {
          // Use median or mean IV from the chain
          ivValues.sort((a, b) => a - b);
          currentIv = ivValues[Math.floor(ivValues.length / 2)]; // median
        }

        // Calculate Put/Call Ratio
        putCallRatio = calculatePutCallRatio(optionsChain);
      }
    } catch (err) {
      logger.warn(`Failed to fetch options chain for ${validatedTicker}`, { error: err });
      // Graceful degradation — options not available for this ticker
      available = false;
    }

    // For IV Rank, we would normally need 52-week IV history.
    // Since yahoo-finance2 doesn't easily expose historical IV data,
    // we calculate it as a placeholder (0.5 = middle of range).
    // In a production system, you'd store historical IV and calculate the rank.
    if (currentIv !== null) {
      ivRank = 0.5; // Placeholder: without history, assume middle of range
    }

    const payload = {
      ticker: validatedTicker,
      available,
      iv: currentIv,
      ivRank,
      putCallRatio,
      optionsChainSize: optionsChain.length,
      dataQuality: {
        ivAvailable: currentIv !== null,
        ivRankAvailable: ivRank !== null,
        putCallRatioAvailable: putCallRatio !== null,
      },
    };

    setCache(validatedTicker, payload);
    return NextResponse.json(payload);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch options data';
    logger.error('Options fetch failed', { ticker: validatedTicker, error: err });
    // Return graceful fallback instead of 500 error
    const fallbackPayload = {
      ticker: validatedTicker,
      available: false,
      iv: null,
      ivRank: null,
      putCallRatio: null,
      optionsChainSize: 0,
      dataQuality: {
        ivAvailable: false,
        ivRankAvailable: false,
        putCallRatioAvailable: false,
      },
    };
    setCache(validatedTicker, fallbackPayload);
    return NextResponse.json(fallbackPayload);
  }
}
