/**
 * Ollama-backed NER pass for the deepmoney discovery pipeline. Given raw
 * article text, asks a local Ollama model to extract company names,
 * industries, and related companies, then resolves those entities to
 * US-listed tickers via Yahoo Finance search + a static industry map.
 *
 * Feature-flagged behind OLLAMA_ENABLED; all failures are silent so the
 * regex-driven primary pipeline is never disrupted.
 */

import { createLogger } from './logger';
import { resolveIndustryTickers } from './industryTickerMap';
import { isOllamaEnabled, checkOllamaReachable, generateJson } from './ollamaClient';

const logger = createLogger('utils/ollamaTicker');

const OLLAMA_BASE_URL  = process.env.OLLAMA_BASE_URL  || 'http://localhost:11434';
// Concurrency raised 10 → 20 and per-run cap lowered 50 → 25. The cap change
// is the wall-clock win: NER work drops linearly. The prior baseline (2026-07-14)
// showed the cap hit at 50/50, so we know halving still leaves plenty of
// signal. Concurrency bump keeps saturation on the local Ollama when the box
// can handle it. Both are still env-tunable for boxes where Ollama is CPU-bound.
const OLLAMA_CONCURRENCY = Number(process.env.OLLAMA_CONCURRENCY) || 20;
const OLLAMA_MAX_ARTICLES = Number(process.env.OLLAMA_MAX_ARTICLES) || 25;

// Re-export for callers that already imported these names from ollamaTicker.
// They now live in ollamaClient.ts; keeping the re-exports means we don't
// churn a bunch of unrelated imports across the codebase during Item 0.
export { isOllamaEnabled, checkOllamaReachable };

/** Item 5 — categorical event tag returned alongside the NER results.
 *  Piggybacks on the existing extractEntitiesWithOllama() call rather than
 *  making a second Ollama request per article. The LLM is instructed to pick
 *  exactly one; anything not in this enum (including `null`) is treated as
 *  a soft "unknown" and dropped from downstream aggregation. */
export const EVENT_TYPES = [
    'earnings',
    'M&A',
    'lawsuit',
    'executive_change',
    'analyst_action',
    'product',
    'regulatory',
    'other',
] as const;
export type EventType = typeof EVENT_TYPES[number];
const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

export interface OllamaEntities {
    companies:  string[];
    industries: string[];
    related:    string[];
    /** Primary event described by the article — null when the LLM returned a
     *  value outside the enum or omitted the field entirely. */
    event_type: EventType | null;
}

/** Input record for the NER pass. `text` is what Ollama sees; the rest is
 *  metadata carried through for downstream persistence (e.g. news table). */
export interface OllamaArticle {
    text:     string;
    title?:   string;
    link?:    string;
    pubDate?: string;
    source?:  string;
}

export interface OllamaPassResult {
    enabled:        boolean;
    reachable:      boolean;
    articlesScanned: number;
    companiesFound: number;
    industriesFound: number;
    tickersResolved: number;
    tickers:        Set<string>;
    /** Item 5 — per-ticker counts of event types seen across the articles
     *  that mentioned each ticker in this run. Empty when Ollama was off. */
    eventTypeCounts: Record<string, Partial<Record<EventType, number>>>;
    /** Item 5 — the most common event type per ticker (mode of the counts
     *  above). Ties broken alphabetically for determinism. Empty when
     *  Ollama was off or no article/ticker mapping was recoverable. */
    dominantEventByTicker: Record<string, EventType>;
    /** Per-article event_type aligned with the input `articles` array. Entries
     *  are `null` for articles Ollama didn't score (deduped by text prefix,
     *  past the OLLAMA_MAX_ARTICLES cap, malformed response, or a value outside
     *  the enum). Callers persisting to the news table zip this with their
     *  input to attribute event_type per link. */
    articleEventTypes: (EventType | null)[];
}

const PROMPT_TEMPLATE = `You are a financial analyst. Read this news article and extract:
1. Any company names mentioned (public or private)
2. Any industries or sectors discussed
3. Any companies mentioned as suppliers, customers, or competitors
4. The single primary event type described by the article. Choose exactly ONE from this list:
   - earnings         (quarterly results, guidance, beats/misses)
   - M&A              (acquisitions, mergers, spinoffs, tender offers)
   - lawsuit          (litigation, settlements, regulatory enforcement actions)
   - executive_change (CEO/CFO hire, departure, board change)
   - analyst_action   (upgrade, downgrade, initiation, price-target change)
   - product          (launches, features, updates, roadmap)
   - regulatory       (FDA approval, antitrust, licensing, policy)
   - other            (anything not above)

Respond ONLY with valid JSON in this exact shape:
{"companies":["Apple Inc","TSMC"],"industries":["semiconductor","consumer electronics"],"related":["Foxconn","Samsung"],"event_type":"product"}
Article:
`;

const US_EXCHANGES = new Set(['NMS', 'NYQ', 'ASE', 'NGM', 'PCX', 'BATS']);

function parseEventType(v: unknown): EventType | null {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return EVENT_TYPE_SET.has(trimmed) ? (trimmed as EventType) : null;
}

/**
 * Send one article to Ollama and parse its JSON response. Returns null when
 * the model is unreachable, the response is malformed, or the timeout fires.
 */
export async function extractEntitiesWithOllama(text: string): Promise<OllamaEntities | null> {
    const trimmed = (text || '').trim();
    if (trimmed.length === 0) return null;

    // 4k char cap keeps prompt+article well under the model's context window
    // even on small Llama variants. News article bodies that long are rare;
    // when present, the head usually has the salient names.
    const articleSlice = trimmed.slice(0, 4_000);

    const parsed = await generateJson<{ companies?: unknown; industries?: unknown; related?: unknown; event_type?: unknown }>(
        PROMPT_TEMPLATE + articleSlice,
        // num_predict bumped modestly to leave room for the new event_type
        // field the LLM now emits. 200 was tight when the JSON only had 3 arrays.
        { numPredict: 250 },
    );
    if (parsed === null) return null;
    return {
        companies:  toStringArray(parsed.companies),
        industries: toStringArray(parsed.industries),
        related:    toStringArray(parsed.related),
        event_type: parseEventType(parsed.event_type),
    };
}

function toStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * Resolve a list of company-name strings to US-listed ticker symbols by
 * hitting Yahoo Finance's autocomplete endpoint. We accept only EQUITY /
 * ETF quoteTypes on US exchanges and require the returned long/short name
 * to overlap with the queried name (first-word match) to avoid the obvious
 * false positives ("Apple" → APLE the REIT).
 *
 * Returns a Set of tickers for the primary use case (ticker-set expansion
 * in ollamaTickerPass). Item 5 additionally needs the company→ticker map
 * so event-type observations can be rolled up to the right ticker without
 * re-resolving every company — callers that need it use resolveCompaniesToTickerMap
 * below instead.
 */
export async function resolveCompaniesToTickers(companies: string[]): Promise<Set<string>> {
    const map = await resolveCompaniesToTickerMap(companies);
    return new Set(map.values());
}

/**
 * Same as resolveCompaniesToTickers but returns the full company→ticker
 * mapping so callers can attribute per-article/per-company observations to
 * the right ticker. Companies that Yahoo couldn't resolve are absent from
 * the map. Preserves original casing on keys (matches input).
 */
async function resolveCompaniesToTickerMap(companies: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const c of companies) {
        const trimmed = c.trim();
        if (trimmed.length < 2) continue;
        const k = trimmed.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        cleaned.push(trimmed);
    }
    if (cleaned.length === 0) return map;

    const BATCH = 5;
    for (let i = 0; i < cleaned.length; i += BATCH) {
        const slice = cleaned.slice(i, i + BATCH);
        const results = await Promise.allSettled(slice.map(name => resolveSingleCompany(name)));
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status === 'fulfilled' && r.value) map.set(slice[j], r.value);
        }
    }
    return map;
}

async function resolveSingleCompany(name: string): Promise<string | null> {
    try {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=3&newsCount=0`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        const quotes: any[] = Array.isArray(data?.quotes) ? data.quotes : [];

        const lowerName = name.toLowerCase();
        const queryFirstWord = lowerName.split(/\s+/)[0] || '';

        for (const q of quotes) {
            const sym       = (q?.symbol     || '').toUpperCase();
            const exchange  = (q?.exchange   || '').toUpperCase();
            const quoteType = (q?.quoteType  || '').toUpperCase();
            if (!sym) continue;
            if (quoteType !== 'EQUITY' && quoteType !== 'ETF') continue;
            if (!US_EXCHANGES.has(exchange)) continue;

            const longName = (q?.longname || q?.shortname || '').toLowerCase();
            if (!longName) continue;

            // Accept when either name contains the other, OR the result name
            // starts with the queried first word. Cheap heuristic but it
            // catches "Apple Inc" → AAPL while rejecting "Apple Hospitality REIT".
            if (
                longName.includes(lowerName) ||
                lowerName.includes(longName) ||
                (queryFirstWord && longName.startsWith(queryFirstWord))
            ) {
                return sym;
            }
        }
        return null;
    } catch {
        return null;
    }
}

export function resolveIndustriesToTickers(industries: string[]): Set<string> {
    const out = new Set<string>();
    for (const ind of industries) {
        for (const t of resolveIndustryTickers(ind)) out.add(t);
    }
    return out;
}

/**
 * Orchestrates the full NER pass over a batch of article texts. Bounded
 * concurrency keeps Ollama from being slammed; the article cap keeps a
 * worst-case run from running unbounded. Returns a structured result so
 * the caller can surface counters in the run summary without re-deriving
 * them.
 */
export async function ollamaTickerPass(input: string[] | OllamaArticle[]): Promise<OllamaPassResult> {
    // Accept either the legacy string[] shape or the richer OllamaArticle[] so
    // callers migrating incrementally don't need to change everything at once.
    const articles: OllamaArticle[] = input.map(item =>
        typeof item === 'string' ? { text: item } : item
    );

    const empty: OllamaPassResult = {
        enabled: isOllamaEnabled(),
        reachable: false,
        articlesScanned: 0,
        companiesFound: 0,
        industriesFound: 0,
        tickersResolved: 0,
        tickers: new Set<string>(),
        eventTypeCounts: {},
        dominantEventByTicker: {},
        articleEventTypes: new Array(articles.length).fill(null),
    };
    if (!empty.enabled) return empty;
    if (articles.length === 0) return empty;

    const reachable = await checkOllamaReachable();
    if (!reachable) {
        logger.info('Ollama not reachable — skipping NER pass', { baseUrl: OLLAMA_BASE_URL });
        return empty;
    }

    // Dedup articles before processing — many feeds republish headlines.
    // `dedupedIndex[i]` holds the position in the *input* `articles` array
    // that this deduped slot corresponds to, so we can write per-article
    // event_type back to the input-aligned output.
    const seenText = new Set<string>();
    const deduped: OllamaArticle[] = [];
    const dedupedIndex: number[] = [];
    for (let i = 0; i < articles.length; i++) {
        const t = articles[i]?.text || '';
        const k = t.trim().slice(0, 200);
        if (k.length === 0 || seenText.has(k)) continue;
        seenText.add(k);
        deduped.push(articles[i]);
        dedupedIndex.push(i);
        if (deduped.length >= OLLAMA_MAX_ARTICLES) break;
    }

    const allCompanies  = new Set<string>();
    const allIndustries = new Set<string>();
    // Item 5 — per-company list of event types seen across all articles that
    // mentioned it. The company → ticker resolution happens after this loop;
    // once we have (company, ticker) pairs we can roll counts up to tickers.
    const eventTypesByCompany = new Map<string, EventType[]>();
    // Per-article event_type indexed against the input `articles` array.
    // Entries stay null for skipped/duplicate/failed articles.
    const articleEventTypes: (EventType | null)[] = new Array(articles.length).fill(null);

    for (let i = 0; i < deduped.length; i += OLLAMA_CONCURRENCY) {
        const batch = deduped.slice(i, i + OLLAMA_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(a => extractEntitiesWithOllama(a.text)));
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status !== 'fulfilled' || !r.value) continue;
            const { companies, related, industries, event_type } = r.value;
            for (const c of companies)  allCompanies.add(c);
            for (const c of related)    allCompanies.add(c);
            for (const ind of industries) allIndustries.add(ind);

            // Only track event_type when the LLM returned a valid enum value.
            // Attribute the article's event_type to every company it named
            // (primary + related) — the article is "about" all of them.
            if (event_type !== null) {
                articleEventTypes[dedupedIndex[i + j]] = event_type;
                for (const c of [...companies, ...related]) {
                    const list = eventTypesByCompany.get(c) ?? [];
                    list.push(event_type);
                    eventTypesByCompany.set(c, list);
                }
            }
        }
    }

    const companyTickerMap = await resolveCompaniesToTickerMap(Array.from(allCompanies));
    const industryTickers  = resolveIndustriesToTickers(Array.from(allIndustries));

    const merged = new Set<string>();
    for (const t of companyTickerMap.values()) merged.add(t);
    for (const t of industryTickers)           merged.add(t);

    // Item 5 — roll event-type counts up from companies to tickers using the
    // already-resolved map. IndustryTickers came from a static map without
    // article attribution, so they don't contribute to dominantEventByTicker.
    const { eventTypeCounts, dominantEventByTicker } = _aggregateEventsByTicker(
        eventTypesByCompany,
        companyTickerMap,
    );

    logger.info('Ollama NER pass complete', {
        articles: deduped.length,
        companies: allCompanies.size,
        industries: allIndustries.size,
        tickers: merged.size,
        tickersWithEventType: Object.keys(dominantEventByTicker).length,
    });

    return {
        enabled: true,
        reachable: true,
        articlesScanned: deduped.length,
        companiesFound: allCompanies.size,
        industriesFound: allIndustries.size,
        tickersResolved: merged.size,
        tickers: merged,
        eventTypeCounts,
        dominantEventByTicker,
        articleEventTypes,
    };
}

/**
 * Roll company-level event-type observations up to tickers using a
 * pre-computed company→ticker map (so we don't hit Yahoo a second time).
 * Ties in the dominant-event vote are broken alphabetically so the same
 * input always produces the same output.
 */
function _aggregateEventsByTicker(
    eventTypesByCompany: Map<string, EventType[]>,
    companyToTicker: Map<string, string>,
): {
    eventTypeCounts: Record<string, Partial<Record<EventType, number>>>,
    dominantEventByTicker: Record<string, EventType>,
} {
    const eventsByTicker = new Map<string, EventType[]>();
    for (const [company, evs] of eventTypesByCompany) {
        const sym = companyToTicker.get(company);
        if (!sym) continue;
        const bucket = eventsByTicker.get(sym) ?? [];
        for (const e of evs) bucket.push(e);
        eventsByTicker.set(sym, bucket);
    }

    const eventTypeCounts: Record<string, Partial<Record<EventType, number>>> = {};
    const dominantEventByTicker: Record<string, EventType> = {};
    for (const [sym, evs] of eventsByTicker) {
        const counts: Partial<Record<EventType, number>> = {};
        for (const e of evs) counts[e] = (counts[e] ?? 0) + 1;
        eventTypeCounts[sym] = counts;

        // Pick the mode; alphabetical tie-break for determinism.
        let best: EventType | null = null;
        let bestCount = 0;
        for (const e of EVENT_TYPES) {
            const c = counts[e] ?? 0;
            if (c > bestCount || (c > 0 && c === bestCount && best !== null && e < best)) {
                bestCount = c;
                best = e;
            }
        }
        if (best) dominantEventByTicker[sym] = best;
    }
    return { eventTypeCounts, dominantEventByTicker };
}
