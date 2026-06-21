import { NextResponse, NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { isInternalRequest } from '@/utils/internalAuth';
import { createErrorResponse, unauthorizedResponse, forbiddenResponse } from '@/utils/errorResponse';
import { deepmoneyCache } from '@/utils/cache';
import { deepmoneyLimiter } from '@/utils/rateLimiter';
import { getClientIP } from '@/utils/rateLimitMiddleware';
import { createLogger } from '@/utils/logger';
import YahooFinance from 'yahoo-finance2';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators';
import { XMLParser } from 'fast-xml-parser';
import Sentiment from 'sentiment';
import { analyzeStocks } from './analyzer';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { performETFDiscovery } from '@/utils/etfDiscovery';
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy';
import { resolveAlgorithm } from '@/utils/algorithmPreset';

const logger = createLogger('api/prediction/deepmoney');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const sentiment = new Sentiment();
const xmlParser = new XMLParser();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEY_BASE = 'hot-tickers-enriched';
const CACHE_TTL_SECONDS = 300; // 5 minutes

const PRIMARY_FEED_URLS = [
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EDJI',
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC',
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EIXIC',
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=small_cap_gainers&count=25',
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=most_actives',
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=undervalued_growth_stocks',
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=aggressive_small_caps',
    'https://www.marketbeat.com/feed/',
    'https://www.thestreet.com/.rss/feed/a4a58455-5a41-4dfa-899c-86c49b653ed8.xml',
    'https://www.fool.com/a/feeds/partner/googlechromefollow?apikey=5e092c1f-c5f9-4428-9219-908a47d2e2de',
    'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',
    'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',
    'https://seekingalpha.com/feed.xml',
    'https://investing.com/rss/news_25.rss',
    'https://cnbc.com/id/20409666/device/rss/rss.html',
    'https://tipranks.com/news',
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=40&search_text=&output=atom',
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40&output=atom',
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&output=atom',
    'https://apewisdom.io/api/v1.0/filter/all-stocks',
    'https://feeds.feedburner.com/typepad/alleyinsider/silicon_alley_insider', // Tech
    'https://www.fiercebiotech.com/rss/xml',                                   // Biotech
    'https://www.fierceelectronics.com/rss/xml',                               // Semiconductors
    'https://www.spacenews.com/feed/',                                         // Aerospace/Defense
    'https://oilprice.com/rss/main',                                           // Energy / commodities
    'https://www.dia.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=661&isdashboardselected=0&max=20', // Defense Intelligence Agency news
    // Defense News — Arc Publishing JSON. Two narrow sections (land + space)
    // so we don't double-count air/naval/pentagon stories. The mxId=00000000
    // placeholder is the unauthenticated default.
    'https://www.defensenews.com/pf/api/v3/content/fetch/story-feed-sections?query=%7B%22excludeSections%22%3A%22%2Fair%22%2C%22feedOffset%22%3A0%2C%22feedSize%22%3A5%2C%22includeSections%22%3A%22%2Fland%22%7D&filter=%7B_id%2Ccontent_elements%7B_id%2Cadditional_properties%7Badvertising%7BcommercialAdNode%2CplayAds%2CplayVideoAds%2CvideoAdZone%7D%7D%2Ccanonical_url%2Ccredits%7Bby%7B_id%2Cadditional_properties%7Boriginal%7Bbyline%2Cemail%7D%7D%2Cdescription%2Cimage%2Cname%2Cslug%2Ctype%7D%7D%2Cdescription%7Bbasic%7D%2Cdisplay_date%2Cembed_html%2Cheadlines%7Bbasic%2Cweb%7D%2Clabel%7Boverline_color%7Btext%7D%2Coverline_text%7Btext%7D%7D%2Cpromo_items%7Bbasic%7B_id%2Cadditional_properties%7Bfocal_point%7Bmax%2Cmin%2Cx%2Cy%7D%7D%2Calt_text%2Cauth%7B1%7D%2Ccontent%2Cembed_html%2Cheight%2Cimage_type%2Ctype%2Curl%2Cwidth%7D%7D%2Crelated_content%7Bbasic%7Breferent%7Btype%7D%7D%2Credirect%7Bredirect_url%7D%7D%2Cshort_url%2Csubheadlines%7Bbasic%7D%2Csubtype%2Ctaxonomy%7Badditional_properties%7Bparent_site_primaries%7BsectionId%7D%7D%2Cprimary_section%7B_id%2C_website%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cparent%7D%2Csections%7B_id%2Cname%2Cpath%7D%2Ctags%7Btext%7D%7D%2Ctype%2Cwebsite%2Cwebsite_url%2Cwebsites%7Bair-force-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Carmy-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cc4isrnet%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cdefense-news%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cfederal-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cmarine-corps-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cmilitary-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cnavy-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%7D%7D%2Ccount%2Cnext%2Csize%2Ctype%7D&d=143&mxId=00000000&_website=defense-news',
    'https://www.defensenews.com/pf/api/v3/content/fetch/story-feed-sections?query=%7B%22excludeSections%22%3A%22%2Fnaval%2C%2Fland%2C%2Fair%2C%2Fpentagon%22%2C%22feedOffset%22%3A0%2C%22feedSize%22%3A5%2C%22includeSections%22%3A%22%2Fspace%22%7D&filter=%7B_id%2Ccontent_elements%7B_id%2Cadditional_properties%7Badvertising%7BcommercialAdNode%2CplayAds%2CplayVideoAds%2CvideoAdZone%7D%7D%2Ccanonical_url%2Ccredits%7Bby%7B_id%2Cadditional_properties%7Boriginal%7Bbyline%2Cemail%7D%7D%2Cdescription%2Cimage%2Cname%2Cslug%2Ctype%7D%7D%2Cdescription%7Bbasic%7D%2Cdisplay_date%2Cembed_html%2Cheadlines%7Bbasic%2Cweb%7D%2Clabel%7Boverline_color%7Btext%7D%2Coverline_text%7Btext%7D%7D%2Cpromo_items%7Bbasic%7B_id%2Cadditional_properties%7Bfocal_point%7Bmax%2Cmin%2Cx%2Cy%7D%7D%2Calt_text%2Cauth%7B1%7D%2Ccontent%2Cembed_html%2Cheight%2Cimage_type%2Ctype%2Curl%2Cwidth%7D%7D%2Crelated_content%7Bbasic%7Breferent%7Btype%7D%7D%2Credirect%7Bredirect_url%7D%7D%2Cshort_url%2Csubheadlines%7Bbasic%7D%2Csubtype%2Ctaxonomy%7Badditional_properties%7Bparent_site_primaries%7BsectionId%7D%7D%2Cprimary_section%7B_id%2C_website%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cparent%7D%2Csections%7B_id%2Cname%2Cpath%7D%2Ctags%7Btext%7D%7D%2Ctype%2Cwebsite%2Cwebsite_url%2Cwebsites%7Bair-force-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Carmy-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cc4isrnet%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cdefense-news%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cfederal-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cmarine-corps-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cmilitary-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%2Cnavy-times%7Bwebsite_section%7B_id%2Cadditional_properties%7Bancestors%2Coriginal%7Bsite%7Bforce_overline%7D%7D%7D%2Cname%2Cpath%7D%7D%7D%7D%2Ccount%2Cnext%2Csize%2Ctype%7D&d=143&mxId=00000000&_website=defense-news',
];

const YAHOO_TICKER_FEED_BASE = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=';

/**
 * Fixed list of widely-held ETFs whose top holdings are merged into the
 * candidate pool every run. Same pattern as PRIMARY_FEED_URLS — bake the
 * list into code, no env var. The /holdings endpoint is queried per ETF
 * concurrently, with a single ETF failure being non-fatal.
 */
const POPULAR_ETF_TICKERS = [
    'SPY', 'QQQ', 'IWM', 'VTI', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP',
    'XLI', 'XLU', 'XLRE', 'GLD', 'ARKK', 'VOO', 'DIA', 'EEM', 'SMH', 'HYG',
];

/**
 * Regex patterns for extracting stock tickers from text.
 */
const TICKER_PATTERNS = [
    /\$([A-Z]{1,5})\b/g,                          // $AAPL style
    /\b([A-Z]{2,5})\s+(?:stock|shares|ticker)\b/g, // "AAPL stock" style
    /\(([A-Z]{1,5})\)/g,                           // (AAPL) style
    /\bNasdaq:\s*([A-Z]{1,5})\b/gi,                // "Nasdaq: AAPL"
    /\bNYSE:\s*([A-Z]{1,5})\b/gi,                  // "NYSE: AAPL"
];

/**
 * Common English words / index tokens that appear uppercase but are not tickers.
 */
const TICKER_STOPLIST = new Set([
    'A', 'I', 'THE', 'AND', 'OR', 'IN', 'AT', 'BY', 'FOR', 'ON', 'OF', 'TO',
    'UP', 'AS', 'IS', 'IT', 'BE', 'DO', 'NO', 'SO', 'IF', 'AN', 'AM', 'US',
    'CEO', 'CFO', 'COO', 'IPO', 'ETF', 'GDP', 'CPI', 'PPI', 'AI', 'EPS',
    'SEC', 'FTC', 'DOJ', 'FDA', 'FED', 'IMF', 'ECB', 'ESG', 'LLC', 'LTD',
    'INC', 'CORP', 'PLC', 'NYSE', 'REIT', 'DJI', 'SPX', 'NDX', 'VIX',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a single RSS feed URL and return its raw XML text.
 */
async function fetchFeed(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
         //   logger.warn(`Feed returned ${res.status}: ${url}`);
            return null;
        }
        return await res.text();
    } catch {
        // External feeds fail regularly (blocks, timeouts, rate limits) — not an error condition
        return null;
    }
}

/**
 * Extract all plain text content (title + description) from RSS <item> elements.
 */
function extractTextFromRSS(xml: string): string {
    const chunks: string[] = [];
    const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
    const tagRegex = /<[^>]+>/g;

    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(xml)) !== null) {
        const itemBody = itemMatch[1];
        const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(itemBody);
        const descMatch = /<description[^>]*>([\s\S]*?)<\/description>/i.exec(itemBody);

        if (titleMatch) chunks.push(titleMatch[1].replace(tagRegex, ' '));
        if (descMatch) chunks.push(descMatch[1].replace(tagRegex, ' '));
    }
    return chunks.join(' ');
}

/**
 * Run all ticker-extraction patterns over a block of text and return a
 * deduplicated set of candidate ticker symbols.
 */
function extractTickers(text: string): Set<string> {
    const found = new Set<string>();
    for (const pattern of TICKER_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const ticker = match[1].toUpperCase();
            if (!TICKER_STOPLIST.has(ticker)) {
                found.add(ticker);
            }
        }
    }
    return found;
}

/**
 * Extract tickers from Yahoo Finance screener JSON response.
 */
function extractTickersFromYahooScreenerJson(jsonData: any): Set<string> {
    const found = new Set<string>();
    try {
        if (jsonData?.finance?.result?.[0]?.quotes) {
            for (const item of jsonData.finance.result[0].quotes) {
                if (item.symbol && !TICKER_STOPLIST.has(item.symbol.toUpperCase())) {
                    found.add(item.symbol.toUpperCase());
                }
            }
        }
    } catch (err) {
        logger.error('Failed to parse Yahoo screener JSON', err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) });
    }
    return found;
}

/**
 * Extract tickers from SEC Form 4 XML response.
 */
function extractTickersFromSECForm4Xml(xmlData: string): Set<string> {
    const found = new Set<string>();
    try {
        const jsonObj = xmlParser.parse(xmlData);
        const entries = jsonObj?.feed?.entry;

        if (entries) {
            // Ensure entries is an array, even if there's only one entry
            const entryList = Array.isArray(entries) ? entries : [entries];

            for (const entry of entryList) {
                const ticker = entry?.['edgar:issuerTradingSymbol'];
                if (ticker && typeof ticker === 'string' && !TICKER_STOPLIST.has(ticker.toUpperCase())) {
                    found.add(ticker.toUpperCase());
                }
            }
        }
    } catch (err) {
        logger.error('Failed to parse SEC Form 4 XML', err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) });
    }
    return found;
}

/**
 * Fetch all primary feeds concurrently and return a combined set of tickers.
 */
async function fetchPrimaryTickers(): Promise<Set<string>> {
    const results = await Promise.allSettled(PRIMARY_FEED_URLS.map(async (url) => {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) return null;
            
            const contentType = res.headers.get('content-type') || '';
            const body = await res.text();

            if (url.includes('type=4') && url.includes('output=atom')) {
                return { type: 'sec_form_4_xml', data: body };
            } else if (contentType.includes('application/json') || body.trim().startsWith('{')) {
                try {
                    return { type: 'json', data: JSON.parse(body) };
                } catch {
                    return { type: 'rss', data: body };
                }
            }
            return { type: 'rss', data: body };
        } catch (err) {
            logger.warn(`Failed to fetch primary source: ${url}`, { error: String(err) });
            return null;
        }
    }));

    const allTickers = new Set<string>();

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            const { type, data } = result.value;
            
            if (type === 'json') {
                // Specific handler for ApeWisdom JSON structure
                if (data && Array.isArray(data.results)) {
                    data.results.forEach((item: any) => {
                        // Pre-filter: skip stocks with low historical volume (less than 5 mentions 24h ago)
                        const historicalMentions = item.mentions_24h_ago || 0;
                        if (historicalMentions < 5) return;

                        if (item.ticker && !TICKER_STOPLIST.has(item.ticker.toUpperCase())) {
                            allTickers.add(item.ticker.toUpperCase());
                        }
                    });
                } else if (data?.finance?.result?.[0]?.quotes) {
                    // Handler for Yahoo Finance screener JSON structure
                    for (const ticker of extractTickersFromYahooScreenerJson(data)) {
                        allTickers.add(ticker);
                    }
                } else if (Array.isArray(data?.content_elements)) {
                    // Arc Publishing PF API (Defense News etc.): walk every
                    // story's headlines / subheadlines / description and run
                    // the same ticker regex used for RSS bodies.
                    const chunks: string[] = [];
                    for (const item of data.content_elements) {
                        const h  = item?.headlines?.basic;
                        const sh = item?.subheadlines?.basic;
                        const d  = item?.description?.basic;
                        if (typeof h  === 'string') chunks.push(h);
                        if (typeof sh === 'string') chunks.push(sh);
                        if (typeof d  === 'string') chunks.push(d);
                    }
                    for (const ticker of extractTickers(chunks.join(' '))) {
                        allTickers.add(ticker);
                    }
                }
            } else if (type === 'sec_form_4_xml') {
                for (const ticker of extractTickersFromSECForm4Xml(data)) {
                    allTickers.add(ticker);
                }
            } else {
                const text = extractTextFromRSS(data);
                for (const ticker of extractTickers(text)) {
                    allTickers.add(ticker);
                }
            }
        }
    }
    return allTickers;
}

/**
 * Secondary discovery pass: query Yahoo ticker-specific feeds.
 */
async function fetchSecondaryTickers(primaryTickers: Set<string>): Promise<Set<string>> {
    if (primaryTickers.size === 0) return primaryTickers;

    // Cap secondary pass to avoid hammering Yahoo with hundreds of simultaneous requests
    const MAX_SECONDARY = 30;
    const secondaryUrls = Array.from(primaryTickers).slice(0, MAX_SECONDARY).map(
        (ticker) => `${YAHOO_TICKER_FEED_BASE}${encodeURIComponent(ticker)}`
    );

    const results = await Promise.allSettled(secondaryUrls.map(fetchFeed));
    const allTickers = new Set<string>(primaryTickers);

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            const text = extractTextFromRSS(result.value);
            for (const ticker of extractTickers(text)) {
                allTickers.add(ticker);
            }
        }
    }
    return allTickers;
}

/**
 * Scrape the Yahoo Finance earnings calendar page for ticker symbols.
 * The page renders tickers as <a href="/quote/AAPL?..."> links in the
 * server-side HTML, so a single regex pull gives us today's reporting names
 * without needing JS execution. Failure is non-fatal — an empty set is
 * returned so the rest of the pipeline continues.
 */
async function fetchYahooEarningsTickers(): Promise<Set<string>> {
    const found = new Set<string>();
    try {
        const res = await fetch('https://finance.yahoo.com/calendar/earnings/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            logger.warn(`Yahoo earnings calendar returned ${res.status}`);
            return found;
        }
        const html = await res.text();
        const linkRegex = /\/quote\/([A-Z]{1,5})(?=[?/"&])/g;
        let m: RegExpExecArray | null;
        while ((m = linkRegex.exec(html)) !== null) {
            const t = m[1].toUpperCase();
            if (!TICKER_STOPLIST.has(t)) found.add(t);
        }
    } catch (err) {
        logger.warn('Yahoo earnings calendar scrape failed', { error: String(err) });
    }
    return found;
}

/**
 * Pull the same Trending-48h feed the /search page renders so the discovery
 * pool includes whatever the market is currently moving on. Set semantics
 * dedup automatically when this is merged with the other feed sources.
 * Non-fatal: a failed fetch returns an empty set, the pipeline proceeds.
 */
async function fetchTrendingTickers(limit: number = 50): Promise<Set<string>> {
    const found = new Set<string>();
    try {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
        const headers: HeadersInit = {};
        if (internalSecret) headers['x-api-key'] = internalSecret;

        const res = await fetch(`${baseUrl}/api/market/trending?window=48h&limit=${limit}`, {
            headers,
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            logger.warn(`Trending feed returned ${res.status}`);
            return found;
        }
        const json = await res.json();
        const stocks = Array.isArray(json?.stocks) ? json.stocks : [];
        for (const s of stocks) {
            const t = (s?.symbol || '').toUpperCase();
            if (t && !TICKER_STOPLIST.has(t)) found.add(t);
        }
    } catch (err) {
        logger.warn('Trending 48h fetch failed', { error: String(err) });
    }
    return found;
}

/**
 * Pull the top holdings of each popular ETF via the internal /holdings
 * endpoint and return the union of holding tickers across them. A single
 * ETF failure is non-fatal — we surface whatever the successful calls
 * returned.
 */
async function fetchEtfHoldingTickers(etfTickers: string[]): Promise<Set<string>> {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
    const headers: HeadersInit = {};
    if (internalSecret) headers['x-api-key'] = internalSecret;

    const results = await Promise.allSettled(etfTickers.map(async (etf) => {
        const res = await fetch(`${baseUrl}/api/stock_data/${encodeURIComponent(etf)}/holdings`, {
            headers,
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`holdings ${etf} returned ${res.status}`);
        return res.json();
    }));

    const merged = new Set<string>();
    for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const holdings = Array.isArray(r.value.holdings) ? r.value.holdings : [];
        for (const h of holdings) {
            const t = (h?.ticker || '').toUpperCase();
            if (t && !TICKER_STOPLIST.has(t)) merged.add(t);
        }
    }
    return merged;
}

/**
 * Fetch consolidated World Bank data.
 */
async function fetchWorldBankData(forceRefresh: boolean = false): Promise<any> {
    try {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
        };

        if (internalSecret) {
            headers['x-api-key'] = internalSecret;
        }

        const url = forceRefresh ? `${baseUrl}/api/worldbank?refresh=true` : `${baseUrl}/api/worldbank`;
        const response = await fetch(url, {
            method: 'GET',
            headers,
        });

        if (!response.ok) {
            throw new Error(`World Bank data fetch failed with status ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        logger.warn('Failed to fetch World Bank data', { error: err });
        return null;
    }
}

/**
 * Enrich a list of tickers with fundamental and technical metrics.
 * Processes all tickers in small batches to avoid overwhelming the API.
 */
async function enrichTickers(tickers: string[]) {
    //logger.info(`Enriching ${tickers.length} tickers with metrics (Full Sweep)`);

    const results: any[] = [];
    const BATCH_SIZE = 5; // Process 5 tickers concurrently to avoid rate limits
    
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
        const batch = tickers.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (ticker) => {
            try {
                const [summary, historicalResult, fundamentals] = await Promise.all([
                    yahooFinance.quoteSummary(ticker, {
                        modules: ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'price', 'assetProfile', 'recommendationTrend']
                    }, { validateResult: false }).catch(() => null),
                    yahooFinance.chart(ticker, {
                        period1: oneYearAgo,
                        period2: yesterday,
                        interval: '1d'
                    }, { validateResult: false }).catch(() => null),
                    yahooFinance.fundamentalsTimeSeries(ticker, {
                        module: 'financials',
                        type: 'annual',
                        period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000)
                    }, { validateResult: false }).catch(() => null)
                ]);

                if (!summary) return { ticker, name: ticker, error: 'No summary data' };

                const historical = (historicalResult as any)?.quotes || [];
                const detail = (summary as any).summaryDetail || {};
                const financial = (summary as any).financialData || {};
                const stats = (summary as any).defaultKeyStatistics || {};
                const price = (summary as any).price || {};
                const profile = (summary as any).assetProfile || {};

                const rdSeries = (fundamentals as any) || [];
                const researchDevelopment = rdSeries[rdSeries.length - 1]?.researchAndDevelopment ?? 0;

                // Analyst recommendation trend — pull the current-month ('0m')
                // strongBuy count for the analyst-consensus override gate in
                // analyzer.ts. Falls back to null when Yahoo has no trend data.
                const trend = ((summary as any).recommendationTrend?.trend ?? []) as Array<{ period?: string; strongBuy?: number }>;
                const currentTrend = trend.find(t => t.period === '0m') ?? trend[0];
                const analystStrongBuy = (typeof currentTrend?.strongBuy === 'number')
                    ? currentTrend.strongBuy
                    : null;

                const marketCap = price.marketCap || detail.marketCap || 0;
                const currentPrice = price.regularMarketPrice || 0;
                // Technical & Growth calculations
                const revenueGrowth = financial.revenueGrowth || 0;
                const earningsGrowth = financial.earningsGrowth || 0;
                const analystTarget = financial.targetMeanPrice || 0;
                const analystUpside = analystTarget > 0 ? (analystTarget - currentPrice) / currentPrice : 0;
                const fiftyTwoWeekChange = stats.fiftyTwoWeekChange || 0;

                const histData = (historical || []).map((r: any) => ({
                    date: new Date(r.date).toISOString().slice(0, 10),
                    open: (r.open as number) || 0,
                    high: (r.high as number) || 0,
                    low: (r.low as number) || 0,
                    close: (r.adjClose as number) || (r.close as number) || 0,
                    volume: (r.volume as number) || 0
                }));

                const tech = histData.length >= 20 
                    ? calculateTechnicalIndicators(histData, [], detail.trailingPE || stats.forwardPE, stats.priceToBook, marketCap)
                    : null;

                return {
                    ticker,
                    name: price.longName || price.shortName || ticker,
                    historyRows: histData.length,
                    price: currentPrice,
                    changePercent: price.regularMarketChangePercent || 0,
                    pe: detail.trailingPE || stats.forwardPE || null,
                    pb: stats.priceToBook || null,
                    debtToEquity: financial.debtToEquity || null,
                    roe: financial.returnOnEquity || null,
                    beta: stats.beta || detail.beta || null,
                    dividendYield: detail.dividendYield || null,
                    marketCap: marketCap,
                    revenueGrowth: revenueGrowth,
                    earningsGrowth: earningsGrowth,
                    grossMargins: financial.grossMargins || 0,
                    researchDevelopment: researchDevelopment,
                    totalRevenue: financial.totalRevenue || 0,
                    fiftyTwoWeekChange: fiftyTwoWeekChange,
                    analystUpside: analystUpside,
                    analystStrongBuy: analystStrongBuy,
                    sma20: tech?.sma20 || null,
                    sma50: tech?.sma50 || null,
                    rsi: tech?.rsi14 || null,
                    tradingSignal: tech?.signal || 'Hold',
                    tradingSignalScore: tech?.scoreBreakdown.totalScore || 0,
                    signalStrength: tech?.signalStrength || 0,
                    sector: profile.sector || 'Unknown'
                    };            } catch (err) {

                logger.warn(`Failed to enrich ${ticker}`, { error: String(err) });
                return { ticker, name: ticker, error: 'Enrichment failed' };
            }
        }));
        results.push(...batchResults);
    }

    return results;
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
    // --- Auth & Origin Split ---
    const isInternal = isInternalRequest(request);
    let sessionUserId: string | number | undefined;

    if (!isInternal) {
        const originCheckResponse = checkOrigin(request as any);
        if (originCheckResponse) return originCheckResponse;

        const session = await getServerSession(authOptions);
        if (!session) {
            logger.warn('Unauthenticated request to hot-tickers endpoint');
            return unauthorizedResponse();
        }
        const approvalOutcome = await checkApprovalGuard(session.user?.id);
        if (!approvalOutcome.allowed) {
            return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
        }
        sessionUserId = session.user?.id;
    }

    // --- Rate limiting (internal requests bypass) ---
    if (!isInternal) {
        const clientIP = getClientIP(request);
        const rateLimitResult = await deepmoneyLimiter.check(clientIP);
        if (!rateLimitResult.allowed) {
            logger.warn(`Rate limit exceeded for ${clientIP}`);
            return forbiddenResponse('Rate limit exceeded. Please try again later.');
        }
    }

    // --- Resolve user's investment timeframe (drives outlook + ML gate) ---
    const userStrategy = sessionUserId
        ? await getUserStrategy(sessionUserId).catch(() => DEFAULT_STRATEGY)
        : DEFAULT_STRATEGY;
    const tfCfg = resolveStrategy(userStrategy).timeframe;
    const outlook = tfCfg.outlook;
    const mlGate = tfCfg.mlGate;
    const CACHE_KEY = `${CACHE_KEY_BASE}:${outlook}`;

    // --- Resolve algorithm preset (single source of truth for all gates) ---
    // The level travels back to deepmoney_sync.py via meta.algorithm; no
    // other env vars are read for tuning behavior from this point on.
    const algorithm = resolveAlgorithm(process.env.DEEPMONEY_ALGORITHM);

    // --- Cache check (bucketed by outlook so each timeframe has its own snapshot) ---
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';

    if (!forceRefresh) {
        const cached = deepmoneyCache.get(CACHE_KEY);
        if (cached) {
            logger.info('Returning cached enriched hot tickers', { outlook });
            return NextResponse.json(cached);
        }
    } else {
        logger.info('DeepMoney V2 force refresh requested', { outlook });
    }


    try {
        logger.info('Starting DeepMoney V2 discovery pass');
        
        // 1. Fetch shared macro and index data once
        const [wbData, primaryTickers] = await Promise.all([
            fetchWorldBankData(forceRefresh),
            fetchPrimaryTickers()
        ]);
        
        let marketIndices = null;
        try {
            const marketIndicesRes = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3001'}/api/market/indices`, {
                headers: { ...(process.env.DEEPMONEY_INTERNAL_SECRET && { 'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET }) },
                signal: AbortSignal.timeout(10_000)
            });
            marketIndices = marketIndicesRes.ok ? await marketIndicesRes.json() : null;
        } catch (idxErr) {
            logger.warn('Failed to fetch market indices for context, proceeding without it', { error: String(idxErr) });
        }

        const allTickersSet = await fetchSecondaryTickers(primaryTickers);

        // --- Merge popular-ETF holdings + Yahoo earnings + Trending-48h (Stage 1) ---
        // Set semantics dedup automatically with feed-discovered tickers.
        const [popularEtfHoldingTickers, yahooEarningsTickers, trendingTickers] = await Promise.all([
            fetchEtfHoldingTickers(POPULAR_ETF_TICKERS),
            fetchYahooEarningsTickers(),
            fetchTrendingTickers(50),
        ]);
        for (const t of popularEtfHoldingTickers) allTickersSet.add(t);
        for (const t of yahooEarningsTickers) allTickersSet.add(t);
        for (const t of trendingTickers) allTickersSet.add(t);

        const newsTickerArray = Array.from(allTickersSet).sort();

        // --- Metric Enrichment (Pass 1: news tickers) ---
        // We need sectors from the enriched news stocks so the ETF qualification
        // can find related ETFs. So enrich the news tickers first, then use
        // their sectors to drive ETF discovery, then enrich any additional
        // holdings tickers in a second pass.
        const newsEnrichedStocks = await enrichTickers(newsTickerArray);

        const seenSectors = new Set<string>();
        newsEnrichedStocks.forEach(s => { if (s.sector) seenSectors.add(s.sector); });

        // --- ETF Discovery (early): qualify ETFs + collect holdings tickers ---
        // Step 2.3 of the analyst-consensus plan: holdings flow through the same
        // enrichTickers + analyzeStocks pipeline as news-discovered tickers,
        // so the analyst-strongBuy override gate applies to them too. We skip
        // scoreETFHoldings here; the analyzer's GPS computation supersedes it
        // for this run. The /holdings endpoint's etf_holding_scores cache will
        // refresh on its own staleness schedule.
        const etfHoldingTickers = new Set<string>();
        const hotEtfs = await performETFDiscovery(
            newsEnrichedStocks,
            Array.from(seenSectors),
            Array.from(allTickersSet),
            { skipHoldingsScoring: true, holdingTickersOut: etfHoldingTickers }
        );

        // --- Metric Enrichment (Pass 2: ETF-holding tickers not in news set) ---
        const newHoldingTickers = Array.from(etfHoldingTickers).filter(t => !allTickersSet.has(t));
        const holdingEnrichedStocks = newHoldingTickers.length > 0
            ? await enrichTickers(newHoldingTickers.sort())
            : [];

        // Merge enriched results + grow allTickersSet so meta counters include holdings
        const enrichedStocks = [...newsEnrichedStocks, ...holdingEnrichedStocks];
        for (const t of newHoldingTickers) allTickersSet.add(t);

        const tickerArray = Array.from(allTickersSet).sort();

        // --- Analysis Filtering ---
        // The ranker keeps only the top algorithm.rankerKeepPct of the enriched
        // pool (Stage 3). Stocks below that cut can still surface via the
        // analyst-strongBuy override lane (threshold also scaled by the
        // algorithm level — higher level surfaces more). All survivors then
        // run through Monte Carlo and the outlook-driven prediction gate.
        const filteredStocks = await analyzeStocks(
            enrichedStocks,
            { wbData, marketIndices },
            {
                outlook,
                mlGate,
                rankerKeepPct: algorithm.rankerKeepPct,
                analystStrongBuyThreshold: algorithm.analystStrongBuyThreshold,
                signalScoreFloor: algorithm.signalScoreFloor,
            },
        );

        const data = {
            success: true,
            timestamp: new Date().toISOString(),
            count: filteredStocks.length,
            stocks: filteredStocks,
            hot_etfs: hotEtfs,
            // Active investment timeframe driving outlook + ML gate. UI can use
            // `timeframe_label` to render e.g. "Predicted +8.2% in 6 months".
            outlook,
            timeframe_label: tfCfg.displayLabel,
            meta: {
                totalDiscovered: tickerArray.length,
                enrichedCount: enrichedStocks.length,
                filteredCount: filteredStocks.length,
                hotEtfsCount: hotEtfs.length,
                primaryCount: primaryTickers.size,
                secondaryCount: allTickersSet.size - primaryTickers.size,
                etfPopularHoldingsCount: popularEtfHoldingTickers.size,
                yahooEarningsTickerCount: yahooEarningsTickers.size,
                feedsQueried: PRIMARY_FEED_URLS.length + primaryTickers.size,
                // Resolved DEEPMONEY_ALGORITHM preset. deepmoney_sync.py reads
                // back from here — it is the only knob for run aggressiveness.
                algorithm,
                debug: {
                    rejectedEnrichment: enrichedStocks.filter(s => s.error).length,
                    rejectedSignalScore: enrichedStocks.filter(s => !s.error && (s.tradingSignalScore === undefined || s.tradingSignalScore < algorithm.signalScoreFloor)).length,
                    rejectedHistory: enrichedStocks.filter(s => !s.error && s.tradingSignalScore !== undefined && s.tradingSignalScore >= algorithm.signalScoreFloor && s.historyRows < 100).length,
                    passedToAnalyzer: enrichedStocks.filter(s => !s.error && s.tradingSignalScore !== undefined && s.tradingSignalScore >= algorithm.signalScoreFloor && s.historyRows >= 100).length,
                    rejectedByRanker: enrichedStocks.filter(s => !s.error && s.tradingSignalScore !== undefined && s.tradingSignalScore >= algorithm.signalScoreFloor && s.historyRows >= 100).length - filteredStocks.length,
                    filteredCount: filteredStocks.length,
                    predictionThreshold: `${mlGate}%`,
                    analystConsensusSurfaced: filteredStocks.filter(s => s.discovery_source === 'analyst_consensus').length,
                    newsTickerCount: newsTickerArray.length,
                    trendingTickerCount: trendingTickers.size,
                    etfHoldingTickerCount: etfHoldingTickers.size,
                    etfHoldingTickerNewlyEnriched: newHoldingTickers.length,
                    predictionSample: filteredStocks.slice(0, 5).map(s => ({ ticker: s.ticker, pred: s.prediction_1m, source: s.discovery_source })),
                }
            },
        };

        // --- Populate cache ---
        deepmoneyCache.set(CACHE_KEY, data, CACHE_TTL_SECONDS);

        return NextResponse.json(data);
    } catch (err) {
        logger.error('Unexpected error fetching hot tickers', err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) });
        return createErrorResponse('Failed to fetch hot tickers', '500');
    }
}
