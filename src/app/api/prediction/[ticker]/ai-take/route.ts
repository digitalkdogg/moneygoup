/**
 * /api/prediction/[ticker]/ai-take
 *
 * Returns a Gemma-generated paragraph analysis of the given ticker for the
 * "Ask AI" button on /search/[ticker]. Cache-first: a SHA-256 of the model
 * name + input data is used as the invalidation key, so the paragraph is
 * regenerated only when GPS / predictions / news actually move.
 *
 * Behavior notes:
 *   - Returns 503 if Ollama isn't reachable or AI_TAKE_ENABLED=off — the UI
 *     can then hide the button gracefully.
 *   - Rate-limits per user per ticker per hour via an in-memory Map (fine for
 *     a single-node dev deploy; swap to a DB table when we shard).
 *   - Deduplicates in-flight requests for the same (ticker, data_hash) so
 *     two users clicking simultaneously don't run two Gemma inferences.
 *   - `?fresh=1` bypasses the cache but still respects rate-limit + dedup.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { unauthorizedResponse, createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { executeRawQuery } from '@/utils/databaseHelper';
import { tickerSchema } from '@/utils/validationSchemas';
import { generate, checkOllamaReachable, isOllamaEnabled } from '@/utils/ollamaClient';
import { createHash } from 'crypto';

const logger = createLogger('api/prediction/ai-take');

// ── Feature config — all overridable via env, sensible defaults baked in. ────
const AI_TAKE_ENABLED             = process.env.AI_TAKE_ENABLED             !== 'off';
const AI_TAKE_CACHE_HOURS         = parseInt(process.env.AI_TAKE_CACHE_HOURS         || '12', 10);
const AI_TAKE_RATE_LIMIT_PER_HOUR = parseInt(process.env.AI_TAKE_RATE_LIMIT_PER_HOUR || '1',  10);
// Feature-local model override — leave OLLAMA_MODEL (used by NER/other
// features) untouched. Gemma 3 4B was chosen for prose quality on CPU.
const AI_TAKE_MODEL               = process.env.OLLAMA_MODEL_AI_TAKE || 'gemma3:4b';
// Generation is ~12-18s on CPU for a WARM model, but cold-load (first click
// after boot, or after `ollama pull`) can push total request time to 60-90s
// on modest hardware. 120s gives cold calls headroom without letting a truly
// stuck request wedge the client forever.
const AI_TAKE_TIMEOUT_MS          = parseInt(process.env.AI_TAKE_TIMEOUT_MS || '120000', 10);

// Rate-limit and in-flight buckets. Both are in-memory — good enough for
// single-node; a DB-backed store is the natural swap when we scale.
const rateBucket = new Map<string, number[]>();          // key → recent request timestamps (ms)
const inFlight   = new Map<string, Promise<string>>();   // (ticker, data_hash) → gen promise

function rateLimitKey(userId: string, ticker: string) { return `${userId}:${ticker.toUpperCase()}`; }

function withinRateLimit(userId: string, ticker: string): boolean {
  const key    = rateLimitKey(userId, ticker);
  const now    = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const prior  = (rateBucket.get(key) ?? []).filter(t => t > cutoff);
  if (prior.length >= AI_TAKE_RATE_LIMIT_PER_HOUR) {
    rateBucket.set(key, prior);
    return false;
  }
  prior.push(now);
  rateBucket.set(key, prior);
  return true;
}

// ── Prompt-input assembly ────────────────────────────────────────────────────
// Pulls the ticker's current data snapshot in one round-trip. Missing fields
// are tolerated — the prompt template handles nulls by omitting sections.
async function fetchTickerContext(ticker: string): Promise<Record<string, unknown> | null> {
  const [rows] = await executeRawQuery(
    `SELECT
       s.symbol, s.company_name, s.sector, s.industry,
       sgs.gps_score, sgs.gps_breakdown,
       rs.current_price, rs.metric_value AS predicted_change_pct,
       rs.analyst_upside_pct, rs.revenue_growth_yoy, rs.gross_margin_pct,
       rs.trailing_pe, rs.price_to_book, rs.market_cap_m,
       rs.trading_signal, rs.classification, rs.discovery_source
     FROM stocks s
     LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
     LEFT JOIN (
       SELECT ticker, MAX(id) AS id FROM recommended_stocks GROUP BY ticker
     ) latest ON latest.ticker = s.symbol
     LEFT JOIN recommended_stocks rs ON rs.id = latest.id
     WHERE s.symbol = ?
     LIMIT 1`,
    [ticker.toUpperCase()],
  );
  const row = (rows as any[])[0];
  if (!row || row.gps_score == null) return null;   // no GPS = no meaningful take
  return row;
}

async function fetchRecentNewsHeadlines(ticker: string): Promise<string[]> {
  try {
    const [rows] = await executeRawQuery(
      `SELECT title
         FROM stock_news
        WHERE symbol = ?
        ORDER BY published_at DESC
        LIMIT 5`,
      [ticker.toUpperCase()],
    );
    return (rows as Array<{ title: string }>).map(r => r.title).filter(Boolean);
  } catch {
    // stock_news schema may vary; fall back silently. The prompt handles [].
    return [];
  }
}

function parseBreakdown(val: unknown): Record<string, unknown> | null {
  if (!val) return null;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return null; } }
  if (typeof val === 'object') return val as Record<string, unknown>;
  return null;
}

function buildPrompt(
  ticker: string,
  ctx: Record<string, unknown>,
  headlines: string[],
): string {
  const breakdown = parseBreakdown(ctx.gps_breakdown);
  const gpsBreakdownStr = breakdown
    ? Object.entries(breakdown)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `${k}=${(v as number).toFixed(1)}`)
        .join(', ')
    : 'n/a';
  const headlineList = headlines.length
    ? headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : 'No recent headlines available.';

  // Reinforce the anti-list constraints in three places — Gemma tends to
  // ignore a single mention and default to structured output otherwise.
  return `Write ONE flowing paragraph of 120-180 words about ${ticker} for a retail investor.
Cover: (1) what the data suggests right now, (2) key risks, and (3) whether it looks like a good buy over the next month based on the numbers.

STRICT RULES — follow all of these:
- Output exactly one paragraph. No headings, no bullet points, no numbered lists, no line breaks.
- Do NOT begin with a title, heading, or the ticker symbol on its own line.
- Do NOT add disclaimers about consulting a financial advisor.
- Do NOT invent facts. Use only the data below.
- Write in a neutral, professional tone (no hype words like "moonshot", "rocket", or "guaranteed").

DATA FOR ${ticker} (${ctx.company_name ?? ticker}):
- Sector: ${ctx.sector ?? 'unknown'} / ${ctx.industry ?? 'unknown'}
- Current price: $${ctx.current_price ?? 'n/a'}
- GPS score: ${ctx.gps_score}/100 (components: ${gpsBreakdownStr})
- 1-month predicted change: ${ctx.predicted_change_pct ?? 'n/a'}%
- Analyst upside: ${ctx.analyst_upside_pct ?? 'n/a'}%
- Revenue growth YoY: ${ctx.revenue_growth_yoy ?? 'n/a'}%
- Gross margin: ${ctx.gross_margin_pct ?? 'n/a'}%
- Trailing PE: ${ctx.trailing_pe ?? 'n/a'}
- Price-to-book: ${ctx.price_to_book ?? 'n/a'}
- Market cap: ${ctx.market_cap_m != null ? `$${ctx.market_cap_m}M` : 'n/a'}
- Trading signal: ${ctx.trading_signal ?? 'n/a'}

RECENT NEWS HEADLINES:
${headlineList}

Now write the paragraph.`;
}

function hashPromptInputs(model: string, ticker: string, ctx: Record<string, unknown>, headlines: string[]): string {
  // Include model in the hash so a model swap invalidates every cached take
  // rather than serving stale prose from a different model.
  const payload = JSON.stringify({
    model,
    ticker: ticker.toUpperCase(),
    gps:       ctx.gps_score,
    breakdown: ctx.gps_breakdown,
    predPct:   ctx.predicted_change_pct,
    upside:    ctx.analyst_upside_pct,
    signal:    ctx.trading_signal,
    headlines,
  });
  return createHash('sha256').update(payload).digest('hex');
}

async function cacheLookup(ticker: string, dataHash: string): Promise<{ paragraph: string; generatedAt: Date; model: string } | null> {
  const [rows] = await executeRawQuery(
    `SELECT paragraph, model, generated_at
       FROM ai_ticker_takes
      WHERE ticker = ? AND data_hash = ?
        AND generated_at > NOW() - INTERVAL ? HOUR
      ORDER BY generated_at DESC LIMIT 1`,
    [ticker.toUpperCase(), dataHash, AI_TAKE_CACHE_HOURS],
  );
  const row = (rows as any[])[0];
  if (!row) return null;
  return { paragraph: row.paragraph, generatedAt: row.generated_at, model: row.model };
}

async function cacheInsert(
  ticker: string,
  dataHash: string,
  model: string,
  paragraph: string,
  gpsAtGen: number | null,
): Promise<void> {
  await executeRawQuery(
    `INSERT INTO ai_ticker_takes (ticker, data_hash, model, paragraph, gps_at_gen)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       paragraph    = VALUES(paragraph),
       model        = VALUES(model),
       gps_at_gen   = VALUES(gps_at_gen),
       generated_at = CURRENT_TIMESTAMP`,
    [ticker.toUpperCase(), dataHash, model, paragraph, gpsAtGen],
  );
}

// ── Route handler ────────────────────────────────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const originGuard = checkOrigin(request);
  if (originGuard) return originGuard;

  if (!AI_TAKE_ENABLED) {
    return NextResponse.json({ message: 'AI take is disabled.' }, { status: 503 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return unauthorizedResponse();
  const userId = String(session.user.id);

  const approval = await checkApprovalGuard(userId);
  if (!approval.allowed) {
    return NextResponse.json({ message: approval.message, code: approval.code }, { status: 403 });
  }

  const { ticker: rawTicker } = await params;
  const parsed = tickerSchema.safeParse(rawTicker);
  if (!parsed.success) {
    return NextResponse.json({ message: 'Invalid ticker.' }, { status: 400 });
  }
  const ticker = parsed.data.toUpperCase();
  const url    = new URL(request.url);
  const fresh  = url.searchParams.get('fresh') === '1';

  try {
    const ctx = await fetchTickerContext(ticker);
    if (!ctx) {
      return NextResponse.json(
        { message: 'No GPS data available for this ticker yet.' },
        { status: 404 },
      );
    }
    const headlines = await fetchRecentNewsHeadlines(ticker);
    const dataHash  = hashPromptInputs(AI_TAKE_MODEL, ticker, ctx, headlines);

    // Always look up the cache — used for both cache-hit fast paths AND as
    // a rate-limit fallback when the user asked for `fresh=1` but is over
    // budget. Fresh users only skip the cache when they're inside their
    // per-hour allowance AND haven't been rate-limited.
    const cached = await cacheLookup(ticker, dataHash);

    if (!fresh && cached) {
      return NextResponse.json({
        paragraph:      cached.paragraph,
        cached:         true,
        generatedAt:    cached.generatedAt,
        model:          cached.model,
        asOfGps:        ctx.gps_score,
      });
    }

    // Rate limit only applies to fresh generations. If the user is over
    // budget AND we have a cached copy, degrade gracefully: return the
    // cache with a `rateLimited` flag so the UI can note that regeneration
    // is throttled. Only 429 when there's genuinely nothing to show.
    if (!withinRateLimit(userId, ticker)) {
      if (cached) {
        return NextResponse.json({
          paragraph:      cached.paragraph,
          cached:         true,
          generatedAt:    cached.generatedAt,
          model:          cached.model,
          asOfGps:        ctx.gps_score,
          rateLimited:    true,
          rateLimitNote:  `Regeneration limited to ${AI_TAKE_RATE_LIMIT_PER_HOUR} per hour — showing the latest cached take.`,
        });
      }
      return NextResponse.json(
        {
          message: `Rate limited — max ${AI_TAKE_RATE_LIMIT_PER_HOUR} fresh AI take${AI_TAKE_RATE_LIMIT_PER_HOUR === 1 ? '' : 's'} per hour per ticker.`,
        },
        { status: 429 },
      );
    }

    // Reachability check — cheaper than a full gen timeout when Ollama is
    // down. Also lets us return 503 so the UI can hide the button.
    const reachable = await checkOllamaReachable();
    if (!reachable) {
      return NextResponse.json(
        { message: 'AI service unavailable — Ollama is not reachable.' },
        { status: 503 },
      );
    }

    // In-flight dedup: if another request is already generating for this
    // exact (ticker, data_hash), reuse its promise instead of firing another
    // Gemma inference (~3GB, would thrash CPU).
    const flightKey = `${ticker}:${dataHash}`;
    let paragraph: string;
    if (inFlight.has(flightKey)) {
      logger.info('AI take dedup: awaiting in-flight generation', { ticker, flightKey });
      paragraph = await inFlight.get(flightKey)!;
    } else {
      const prompt = buildPrompt(ticker, ctx, headlines);
      const genPromise = (async (): Promise<string> => {
        const raw = await generate(prompt, {
          model:      AI_TAKE_MODEL,
          timeoutMs:  AI_TAKE_TIMEOUT_MS,
          numPredict: 350,
          temperature: 0.3,       // slight creativity for prose; 0 reads robotic
          keepAlive:  '24h',      // pin the model in memory between calls
          stop:       ['\n\n', '\n-', '\n*', '\n1.', '\n2.', '**', '##'],
        });
        if (raw === null || raw.trim().length === 0) {
          throw new Error('Ollama returned empty response.');
        }
        return raw.trim();
      })();
      inFlight.set(flightKey, genPromise);
      try {
        paragraph = await genPromise;
      } finally {
        inFlight.delete(flightKey);
      }
    }

    await cacheInsert(
      ticker,
      dataHash,
      AI_TAKE_MODEL,
      paragraph,
      ctx.gps_score != null ? Number(ctx.gps_score) : null,
    );
    logger.info('AI take generated', {
      ticker,
      userId,
      model: AI_TAKE_MODEL,
      length: paragraph.length,
    });

    return NextResponse.json({
      paragraph,
      cached:      false,
      generatedAt: new Date().toISOString(),
      model:       AI_TAKE_MODEL,
      asOfGps:     ctx.gps_score,
    });
  } catch (err) {
    logger.error('AI take generation failed', { ticker, error: err });
    return createErrorResponse(err, 'Failed to generate AI take.');
  }
}
