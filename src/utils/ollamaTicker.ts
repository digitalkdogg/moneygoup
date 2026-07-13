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
const OLLAMA_CONCURRENCY = Number(process.env.OLLAMA_CONCURRENCY) || 10;
const OLLAMA_MAX_ARTICLES = Number(process.env.OLLAMA_MAX_ARTICLES) || 50;

// Re-export for callers that already imported these names from ollamaTicker.
// They now live in ollamaClient.ts; keeping the re-exports means we don't
// churn a bunch of unrelated imports across the codebase during Item 0.
export { isOllamaEnabled, checkOllamaReachable };

export interface OllamaEntities {
    companies:  string[];
    industries: string[];
    related:    string[];
}

export interface OllamaPassResult {
    enabled:        boolean;
    reachable:      boolean;
    articlesScanned: number;
    companiesFound: number;
    industriesFound: number;
    tickersResolved: number;
    tickers:        Set<string>;
}

const PROMPT_TEMPLATE = `You are a financial analyst. Read this news article and extract:
1. Any company names mentioned (public or private)
2. Any industries or sectors discussed
3. Any companies mentioned as suppliers, customers, or competitors
Respond ONLY with valid JSON in this exact shape:
{"companies":["Apple Inc","TSMC"],"industries":["semiconductor","consumer electronics"],"related":["Foxconn","Samsung"]}
Article:
`;

const US_EXCHANGES = new Set(['NMS', 'NYQ', 'ASE', 'NGM', 'PCX', 'BATS']);

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

    const parsed = await generateJson<{ companies?: unknown; industries?: unknown; related?: unknown }>(
        PROMPT_TEMPLATE + articleSlice,
        { numPredict: 200 },
    );
    if (parsed === null) return null;
    return {
        companies:  toStringArray(parsed.companies),
        industries: toStringArray(parsed.industries),
        related:    toStringArray(parsed.related),
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
 */
export async function resolveCompaniesToTickers(companies: string[]): Promise<Set<string>> {
    const tickers = new Set<string>();
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
    if (cleaned.length === 0) return tickers;

    const BATCH = 5;
    for (let i = 0; i < cleaned.length; i += BATCH) {
        const slice = cleaned.slice(i, i + BATCH);
        const results = await Promise.allSettled(slice.map(resolveSingleCompany));
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) tickers.add(r.value);
        }
    }
    return tickers;
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
export async function ollamaTickerPass(articleTexts: string[]): Promise<OllamaPassResult> {
    const empty: OllamaPassResult = {
        enabled: isOllamaEnabled(),
        reachable: false,
        articlesScanned: 0,
        companiesFound: 0,
        industriesFound: 0,
        tickersResolved: 0,
        tickers: new Set<string>(),
    };
    if (!empty.enabled) return empty;
    if (articleTexts.length === 0) return empty;

    const reachable = await checkOllamaReachable();
    if (!reachable) {
        logger.info('Ollama not reachable — skipping NER pass', { baseUrl: OLLAMA_BASE_URL });
        return empty;
    }

    // Dedup articles before processing — many feeds republish headlines.
    const seenText = new Set<string>();
    const deduped: string[] = [];
    for (const t of articleTexts) {
        const k = (t || '').trim().slice(0, 200);
        if (k.length === 0 || seenText.has(k)) continue;
        seenText.add(k);
        deduped.push(t);
        if (deduped.length >= OLLAMA_MAX_ARTICLES) break;
    }

    const allCompanies  = new Set<string>();
    const allIndustries = new Set<string>();

    for (let i = 0; i < deduped.length; i += OLLAMA_CONCURRENCY) {
        const batch = deduped.slice(i, i + OLLAMA_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(extractEntitiesWithOllama));
        for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value) continue;
            for (const c of r.value.companies)  allCompanies.add(c);
            for (const c of r.value.related)    allCompanies.add(c);
            for (const ind of r.value.industries) allIndustries.add(ind);
        }
    }

    const companyTickers = await resolveCompaniesToTickers(Array.from(allCompanies));
    const industryTickers = resolveIndustriesToTickers(Array.from(allIndustries));

    const merged = new Set<string>();
    for (const t of companyTickers)  merged.add(t);
    for (const t of industryTickers) merged.add(t);

    logger.info('Ollama NER pass complete', {
        articles: deduped.length,
        companies: allCompanies.size,
        industries: allIndustries.size,
        tickers: merged.size,
    });

    return {
        enabled: true,
        reachable: true,
        articlesScanned: deduped.length,
        companiesFound: allCompanies.size,
        industriesFound: allIndustries.size,
        tickersResolved: merged.size,
        tickers: merged,
    };
}
