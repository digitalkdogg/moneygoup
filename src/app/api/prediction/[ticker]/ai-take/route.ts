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
 *   - Enforces a 1-minute global per-ticker cooldown between fresh generations
 *     via an in-memory Map (fine for single-node; swap to Redis when we shard).
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
import { generateStream, checkOllamaReachable } from '@/utils/ollamaClient';
import { newsDataCache } from '@/utils/cache';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'crypto';

const logger = createLogger('api/prediction/ai-take');

// ── Feature config — all overridable via env, sensible defaults baked in. ────
const AI_TAKE_ENABLED             = process.env.AI_TAKE_ENABLED             !== 'off';
const AI_TAKE_CACHE_HOURS         = parseInt(process.env.AI_TAKE_CACHE_HOURS         || '12', 10);
// Global per-ticker cooldown between fresh generations (applies to ?fresh=1).
// Normal requests always hit the 12h DB cache first, so this only fires on
// cache misses or explicit refresh clicks.
const AI_TAKE_REGEN_COOLDOWN_MS = parseInt(process.env.AI_TAKE_REGEN_COOLDOWN_MS || String(60 * 1000), 10);
// Feature-local model override — leave OLLAMA_MODEL (used by NER/other
// features) untouched. gemma3:1b generates 3-5x faster than 4b and fits in
// ~1GB RAM; the structured prompt + low temperature compensate for model size.
const AI_TAKE_MODEL               = process.env.OLLAMA_MODEL_AI_TAKE || 'gemma3:1b';
// Generation is ~12-18s on CPU for a WARM model, but cold-load (first click
// after boot, or after `ollama pull`) can push total request time to 60-90s
// on modest hardware. 120s gives cold calls headroom without letting a truly
// stuck request wedge the client forever.
const AI_TAKE_TIMEOUT_MS          = parseInt(process.env.AI_TAKE_TIMEOUT_MS || '120000', 10);

// Per-ticker generation cooldown (global — not per user).  Tracks the last
// time a fresh generation completed for each ticker so rapid refresh clicks
// from any user don't hammer Ollama back-to-back.
const lastGenAt = new Map<string, number>();             // ticker → timestamp (ms)
const inFlight  = new Map<string, Promise<string>>();    // (ticker, data_hash) → gen promise

// ── Stock classifier ─────────────────────────────────────────────────────────

interface StockClassification {
  growthLabel: 'Low Growth' | 'Moderate' | 'Growth' | 'High Growth';
  riskLabel:   'Low Risk'   | 'Moderate Risk' | 'High Risk' | 'Speculative';
  quadrant:    'Quality Growth' | 'Speculative' | 'Defensive' | 'Caution';
}

function classifyStock(ctx: Record<string, unknown>): StockClassification {
  const gps          = Number(ctx.gps_score          ?? 50);
  const predPct      = Number(ctx.predicted_change_pct ?? 0);
  const analystUp    = Number(ctx.analyst_upside_pct  ?? 0);
  const revGrowth    = Number(ctx.revenue_growth_yoy  ?? 0);
  const trailingPe   = Number(ctx.trailing_pe         ?? 0);
  const ptb          = Number(ctx.price_to_book       ?? 0);
  const signal       = String(ctx.trading_signal      ?? '').toLowerCase();

  // ── Growth score (0–100) ──────────────────────────────────────────────────
  // GPS (0–40): direct proportion — our best single-signal quality metric.
  const gpsComp  = (gps / 100) * 40;
  // Predicted 1m change (0–25): clamp –20 % … +30 %, map linearly.
  const predComp = ((Math.max(-20, Math.min(30, predPct)) + 20) / 50) * 25;
  // Analyst upside (0–20): clamp 0 % … 40 %.
  const upComp   = (Math.max(0, Math.min(40, analystUp)) / 40) * 20;
  // Revenue growth YoY (0–15): clamp –20 % … +50 %.
  const revComp  = ((Math.max(-20, Math.min(50, revGrowth)) + 20) / 70) * 15;

  const growthScore = Math.round(gpsComp + predComp + upComp + revComp);

  // ── Risk score (0–100) ────────────────────────────────────────────────────
  // P/E: negative earnings = genuine risk; nosebleed = speculation premium.
  // High PTB alone is NOT a reliable risk signal (AAPL, MSFT, GOOG all trade
  // at extreme book multiples yet are low-volatility businesses), so PTB
  // max is capped at 12 and only negative book value scores the ceiling.
  let peComp = 18;
  if (trailingPe <= 0)       peComp = 28;  // no earnings = real risk
  else if (trailingPe <= 20) peComp = 5;   // reasonable valuation
  else if (trailingPe <= 35) peComp = 10;  // moderate premium (normal for quality)
  else if (trailingPe <= 60) peComp = 18;  // stretched
  else                        peComp = 25;  // nosebleed

  // PTB: only distressed (<0) or extreme (>10) add meaningful risk signal.
  // High-quality brands (PTB 5-30+) are intentionally capped — they carry
  // brand/IP moats that the raw book number doesn't capture.
  let ptbComp = 6;
  if (ptb < 0)        ptbComp = 12;  // negative book = distress
  else if (ptb < 1)   ptbComp = 4;   // cheap on book
  else if (ptb < 5)   ptbComp = 6;   // normal range
  else if (ptb < 10)  ptbComp = 8;   // quality premium — mild uplift only
  else                ptbComp = 12;  // extreme stretch (cap same as distress)

  // Prediction magnitude (0–18): large swings either direction = more
  // uncertainty, but cap is lower now to avoid double-penalizing with PE.
  const magComp = Math.min(18, (Math.abs(predPct) / 30) * 18);

  // Trading signal (0–25): primary directional risk indicator.
  // Neutral baseline drops to 10 — a neutral signal is not inherently risky.
  let sigComp = 10;
  if      (signal.includes('strong') && signal.includes('bull')) sigComp = 4;
  else if (signal.includes('bull'))                               sigComp = 7;
  else if (signal.includes('neutral') || signal === '')          sigComp = 10;
  else if (signal.includes('strong') && signal.includes('bear')) sigComp = 25;
  else if (signal.includes('bear'))                               sigComp = 19;

  // Revenue health (0–12): contraction is a genuine distress signal.
  const revRisk = revGrowth < -10 ? 12 : revGrowth < 0 ? 8 : revGrowth > 30 ? 4 : 5;

  const riskScore = Math.min(100, Math.round(peComp + ptbComp + magComp + sigComp + revRisk));

  // ── Labels ────────────────────────────────────────────────────────────────
  // Thresholds shifted up vs v1 — a healthy neutral-signal S&P 500 stock
  // now lands in Moderate Risk (~38–45) rather than High Risk.
  const growthLabel: StockClassification['growthLabel'] =
    growthScore >= 70 ? 'High Growth' :
    growthScore >= 50 ? 'Growth'      :
    growthScore >= 30 ? 'Moderate'    : 'Low Growth';

  const riskLabel: StockClassification['riskLabel'] =
    riskScore >= 75 ? 'Speculative'   :
    riskScore >= 55 ? 'High Risk'     :
    riskScore >= 35 ? 'Moderate Risk' : 'Low Risk';

  const highGrowth = growthScore >= 50;
  const highRisk   = riskScore   >= 50;
  const quadrant: StockClassification['quadrant'] =
    highGrowth && !highRisk ? 'Quality Growth' :
    highGrowth &&  highRisk ? 'Speculative'    :
   !highGrowth && !highRisk ? 'Defensive'      : 'Caution';

  return { growthLabel, riskLabel, quadrant };
}

/**
 * Build the metadata-header block that every successful response carries.
 * Client reads these to decide badge rendering, rate-limit note, etc.
 */
function metadataHeaders(opts: {
  cached:          boolean;
  model:           string;
  generatedAt:     string;
  asOfGps:         number | string | null;
  classification?: StockClassification | null;
  rateLimited?:    boolean;
  rateLimitNote?:  string;
}): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type':          'text/plain; charset=utf-8',
    'Cache-Control':         'no-store',
    // Disable proxy buffering on nginx (X-Accel-Buffering) and hint to any
    // Cloudflare-style CDN not to buffer — otherwise the whole streamed
    // response gets held on the edge and the browser sees a cut connection.
    'X-Accel-Buffering':     'no',
    'X-AiTake-Cached':       opts.cached ? 'true' : 'false',
    'X-AiTake-Model':        opts.model,
    'X-AiTake-Generated-At': opts.generatedAt,
    'X-AiTake-Asof-Gps':     opts.asOfGps == null ? '' : String(opts.asOfGps),
  };
  if (opts.classification) {
    h['X-AiTake-Growth-Label'] = opts.classification.growthLabel;
    h['X-AiTake-Risk-Label']   = opts.classification.riskLabel;
    h['X-AiTake-Quadrant']     = opts.classification.quadrant;
  }
  if (opts.rateLimited)   h['X-AiTake-Rate-Limited']    = 'true';
  if (opts.rateLimitNote) h['X-AiTake-Rate-Limit-Note'] = opts.rateLimitNote;
  return h;
}

function withinCooldown(ticker: string): boolean {
  const last = lastGenAt.get(ticker.toUpperCase());
  return last !== undefined && Date.now() - last < AI_TAKE_REGEN_COOLDOWN_MS;
}

function recordGen(ticker: string): void {
  lastGenAt.set(ticker.toUpperCase(), Date.now());
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
  // Check the in-memory cache populated by /api/stock_data/[ticker]/news first
  // (avoids a redundant network call when the news panel already loaded).
  const cached = newsDataCache.get(ticker.toUpperCase());
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return (cached as Array<{ title: string }>)
      .slice(0, 5)
      .map(a => a.title)
      .filter(Boolean);
  }

  // Cache cold — fetch directly from Yahoo Finance RSS.
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const parser = new XMLParser();
    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item;
    if (!items) return [];
    const arr = Array.isArray(items) ? items : [items];
    return arr
      .slice(0, 5)
      .map((item: { title?: string }) => item.title)
      .filter(Boolean) as string[];
  } catch {
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

  // Reinforce the anti-list + anti-filler constraints in multiple places —
  // Gemma tends to ignore a single mention and default to structured output
  // or "the company is a leader in X" filler otherwise.
  return `Write ONE flowing paragraph of 60-80 words about ${ticker} for a retail investor.
Cover: (1) the one or two strongest signals in the data, (2) the biggest risk, and (3) end with a single plain-English verdict: is this worth a closer look right now, or not? The verdict must be direct — e.g. "Worth a closer look given..." or "Not compelling right now because...".

STRICT RULES — follow all of these:
- Output exactly one paragraph. No headings, no bullet points, no numbered lists, no line breaks.
- Do NOT begin with a title, heading, or the ticker symbol on its own line.
- Do NOT describe what the company does or explain its business. Assume the reader already knows.
- Do NOT restate obvious data points like "the current price is $X" — the reader has the numbers on screen.
- Do NOT add disclaimers about consulting a financial advisor.
- Do NOT invent facts. Use only the data below.
- Write in a neutral, professional tone. No hype words ("moonshot", "rocket", "guaranteed").
- Every sentence must add analytical value — no filler or hedging.

DATA FOR ${ticker}:
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

function hashPromptInputs(model: string, ticker: string, ctx: Record<string, unknown>): string {
  // Headlines are intentionally excluded — live news changes too frequently
  // and would bust the 12-hour cache on almost every request. The cache key
  // is stable stock metrics only; news is fetched fresh on each generation.
  const payload = JSON.stringify({
    model,
    ticker: ticker.toUpperCase(),
    gps:       ctx.gps_score != null ? Math.round(Number(ctx.gps_score) * 10) / 10 : null,
    breakdown: ctx.gps_breakdown,
    predPct:   ctx.predicted_change_pct,
    upside:    ctx.analyst_upside_pct,
    signal:    ctx.trading_signal,
  });
  return createHash('sha256').update(payload).digest('hex');
}

async function cacheLookup(ticker: string, dataHash: string): Promise<{ paragraph: string; generatedAt: Date; model: string } | null> {
  const [rows] = await executeRawQuery(
    `SELECT paragraph, model, generated_at
       FROM ai_ticker_takes
      WHERE ticker = ? AND data_hash = ?
        AND generated_at > NOW() - INTERVAL ${AI_TAKE_CACHE_HOURS} HOUR
      ORDER BY generated_at DESC LIMIT 1`,
    [ticker.toUpperCase(), dataHash],
  );
  const row = (rows as any[])[0];
  if (!row) return null;
  return { paragraph: row.paragraph, generatedAt: row.generated_at, model: row.model };
}

// Ticker-only lookup — no data hash required. Used by ?cache_only=1 requests
// (auto-load on page mount) so we don't need to join GPS tables just to check
// if any recent paragraph exists.
async function cacheLookupByTicker(ticker: string): Promise<{ paragraph: string; generatedAt: Date; model: string } | null> {
  const [rows] = await executeRawQuery(
    `SELECT paragraph, model, generated_at
       FROM ai_ticker_takes
      WHERE ticker = ?
        AND generated_at > NOW() - INTERVAL ${AI_TAKE_CACHE_HOURS} HOUR
      ORDER BY generated_at DESC LIMIT 1`,
    [ticker.toUpperCase()],
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
  const ticker    = parsed.data.toUpperCase();
  const url       = new URL(request.url);
  const fresh     = url.searchParams.get('fresh') === '1';
  const cacheOnly = url.searchParams.get('cache_only') === '1';

  // Fast path: page auto-load checks for a cached take. Runs the GPS join in
  // parallel with the cache lookup so classification badges are available
  // immediately when we return the cached paragraph.
  if (cacheOnly) {
    const [hit, ctx] = await Promise.all([
      cacheLookupByTicker(ticker),
      fetchTickerContext(ticker),
    ]);
    if (!hit) return new Response(null, { status: 204 });
    return new Response(hit.paragraph, {
      status: 200,
      headers: metadataHeaders({
        cached:         true,
        model:          hit.model,
        generatedAt:    hit.generatedAt instanceof Date
          ? hit.generatedAt.toISOString()
          : String(hit.generatedAt),
        asOfGps:        ctx ? (ctx.gps_score as number | null) : null,
        classification: ctx ? classifyStock(ctx) : null,
      }),
    });
  }

  try {
    // Fire news fetch immediately — it can take up to 6s on a cold RSS call.
    // We await it only if we end up needing to generate; on a cache hit we
    // just let it resolve in the background (suppressing the unhandled
    // rejection so Node doesn't warn).
    const newsPromise = fetchRecentNewsHeadlines(ticker);
    newsPromise.catch(() => { /* background — ignored on cache hit */ });

    const ctx = await fetchTickerContext(ticker);
    if (!ctx) {
      return NextResponse.json(
        { message: 'No GPS data available for this ticker yet.' },
        { status: 404 },
      );
    }

    // Compute once — used in every response branch below.
    const classification = classifyStock(ctx);

    // Hash is based on stable metrics only (headlines excluded) so the cache
    // lookup can short-circuit before the news fetch completes.
    const dataHash = hashPromptInputs(AI_TAKE_MODEL, ticker, ctx);
    const cached   = await cacheLookup(ticker, dataHash);

    if (!fresh && cached) {
      // Cache hit — news fetch is already in flight but we don't need it.
      return new Response(cached.paragraph, {
        status: 200,
        headers: metadataHeaders({
          cached:         true,
          model:          cached.model,
          generatedAt:    cached.generatedAt instanceof Date
            ? cached.generatedAt.toISOString()
            : String(cached.generatedAt),
          asOfGps:        ctx.gps_score as number | string | null,
          classification,
        }),
      });
    }

    // Cache miss — await the already-in-flight news promise. It started at
    // the same time as the DB calls so most of its latency is already gone.
    const headlines = await newsPromise;

    // Cooldown only applies to fresh generations — normal cache-hit requests
    // never reach here. If the ticker was generated in the last minute, serve
    // the cached copy (or 429 if nothing cached yet).
    if (withinCooldown(ticker)) {
      if (cached) {
        return new Response(cached.paragraph, {
          status: 200,
          headers: metadataHeaders({
            cached:         true,
            model:          cached.model,
            generatedAt:    cached.generatedAt instanceof Date
              ? cached.generatedAt.toISOString()
              : String(cached.generatedAt),
            asOfGps:        ctx.gps_score as number | string | null,
            classification,
            rateLimited:    true,
            rateLimitNote:  'Regeneration cooldown active — showing latest cached take.',
          }),
        });
      }
      return NextResponse.json(
        { message: 'Rate limited — please wait 1 minute between regenerations.' },
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
    // exact (ticker, data_hash), await its final paragraph and return it as
    // a single-chunk stream. Sacrifice: the second user waits for the first
    // gen to complete instead of streaming in parallel — this is deliberate
    // because two concurrent gemma3:1b runs would thrash CPU.
    const flightKey    = `${ticker}:${dataHash}`;
    const generatedAt  = new Date().toISOString();
    if (inFlight.has(flightKey)) {
      logger.info('AI take dedup: awaiting in-flight generation', { ticker, flightKey });
      try {
        const paragraph = await inFlight.get(flightKey)!;
        return new Response(paragraph, {
          status: 200,
          headers: metadataHeaders({
            cached:         false,
            model:          AI_TAKE_MODEL,
            generatedAt,
            asOfGps:        ctx.gps_score as number | string | null,
            classification,
          }),
        });
      } catch (err) {
        logger.error('AI take dedup: upstream gen failed', { ticker, error: err });
        return createErrorResponse(err, 'Failed to generate AI take.');
      }
    }

    // Fresh generation — kick off Ollama with stream: true so the client can
    // start rendering within seconds instead of waiting for the whole 80-120
    // word paragraph. On CPU we're still bounded by tokens/sec, but perceived
    // latency drops from "spinner for 60-90s" to "first sentence in ~5-10s".
    const prompt = buildPrompt(ticker, ctx, headlines);
    const ollamaStream = await generateStream(prompt, {
      model:       AI_TAKE_MODEL,
      timeoutMs:   AI_TAKE_TIMEOUT_MS,
      numPredict:  160,          // 60-80 words ≈ 100-130 tokens
      temperature: 0.3,          // slight creativity for prose; 0 reads robotic
      keepAlive:   '24h',        // pin the model in memory between calls
      stop:        ['\n\n', '\n-', '\n*', '\n1.', '\n2.', '**', '##'],
    });
    if (!ollamaStream) {
      throw new Error('Ollama returned empty stream.');
    }

    let resolveGen!: (paragraph: string) => void;
    let rejectGen!:  (err: unknown) => void;
    const genPromise = new Promise<string>((resolve, reject) => {
      resolveGen = resolve;
      rejectGen  = reject;
    });
    genPromise.catch(() => { /* swallowed for orphan case only */ });
    inFlight.set(flightKey, genPromise);

    // async start() drives both streaming to the client AND the cache write.
    // Using start() (not a separate IIFE) is required — Next.js's HTTP layer
    // only streams a ReadableStream when the stream drives itself internally.
    // clientGone is set by cancel() when the browser disconnects; start()
    // checks it before each enqueue but keeps reading Ollama to accumulate
    // the full paragraph so the cache write always runs at the end.
    const encoder   = new TextEncoder();
    let clientGone  = false;
    const clientStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let acc = '';
        const reader = ollamaStream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              acc += value;
              if (!clientGone) {
                try { controller.enqueue(encoder.encode(value)); } catch { clientGone = true; }
              }
            }
          }
          if (!clientGone) {
            try { controller.close(); } catch { /* already closed/cancelled */ }
          }
          const trimmed = acc.trim();
          if (!trimmed) { rejectGen(new Error('Ollama returned empty response.')); return; }
          resolveGen(trimmed);
          await cacheInsert(
            ticker, dataHash, AI_TAKE_MODEL, trimmed,
            ctx.gps_score != null ? Number(ctx.gps_score) : null,
          );
          recordGen(ticker);
          logger.info('AI take cached', { ticker, model: AI_TAKE_MODEL, length: trimmed.length });
        } catch (err) {
          logger.error('AI take cache task failed', { ticker, error: err });
          rejectGen(err);
          if (!clientGone) {
            try { controller.error(err); } catch { /* already closed/cancelled */ }
          }
        } finally {
          inFlight.delete(flightKey);
        }
      },
      cancel(reason) {
        logger.info('AI take stream cancelled by client', { ticker, reason: String(reason) });
        clientGone = true;
        // start() is still running — it will keep reading Ollama and write
        // the cache when done, then exit cleanly.
      },
    });

    return new Response(clientStream, {
      status: 200,
      headers: metadataHeaders({
        cached:         false,
        model:          AI_TAKE_MODEL,
        generatedAt,
        asOfGps:        ctx.gps_score as number | string | null,
        classification,
      }),
    });
  } catch (err) {
    logger.error('AI take generation failed', { ticker, error: err });
    return createErrorResponse(err, 'Failed to generate AI take.');
  }
}
