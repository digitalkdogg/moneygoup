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
import { computeAnalystGrade, RecommendationPeriod } from '@/utils/analystGrade';
import { getSectorStocks, getTrendingStocks } from '@/utils/yahooFinanceHelper';
import { CANONICAL_SECTORS } from '@/utils/sectorTaxonomy';
import { getDbConnection } from '@/utils/db';

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
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=day_gainers',
    // Mutual fund / income screeners — surface a different tail of the market.
    // Most returned tickers (mutual funds, bond funds) won't have OHLCV
    // history and will drop at the analyzer pre-filter, but the universe
    // they expose helps tilt the discovery pool toward names the broader
    // institutional flow is interested in.
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=top_mutual_funds',
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=solid_large_growth_funds',
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=conservative_foreign_funds',
    'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=high_yield_bond',
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
    // Wider SEC filing types — atom feeds go through the generic RSS extractor.
    // Ticker yield depends on whether SEC's atom title/summary mentions a
    // $TICKER; if not, these contribute zero tickers and are harmless.
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13D&dateb=&owner=include&count=40&output=atom', // Activist / large stakes
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13G&dateb=&owner=include&count=40&output=atom', // Passive large stakes
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&dateb=&owner=include&count=40&output=atom',    // IPO filings — surfaces new tickers early
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=425&dateb=&owner=include&count=40&output=atom',    // M&A merger communications
    'https://apewisdom.io/api/v1.0/filter/all-stocks',
    'https://feeds.feedburner.com/typepad/alleyinsider/silicon_alley_insider', // Tech
    'https://www.fiercebiotech.com/rss/xml',                                   // Biotech
    'https://www.fiercepharma.com/rss/xml',                                    // Pharma (distinct from biotech)
    'https://www.fiercehealthcare.com/rss/xml',                                // Healthcare providers / payers
    'https://www.fierceelectronics.com/rss/xml',                               // Semiconductors
    'https://www.spacenews.com/feed/',                                         // Aerospace/Defense
    'https://oilprice.com/rss/main',                                           // Energy / commodities
    'https://www.naturalgasintel.com/feed/',                                   // Energy / natural gas
    'https://www.mining.com/feed/',                                            // Mining / materials
    'https://www.investmentnews.com/feed',                                     // Asset management / financials
    'https://www.spglobal.com/marketintelligence/en/news-insights/rss-feed/all', // S&P market intel
    'https://www.benzinga.com/feed',                                           // General markets, fast-moving
    'https://www.zacks.com/rss/zacks_news_feed.xml',                           // Analyst-driven coverage
    'https://www.barchart.com/news/rss',                                       // Screener-adjacent news
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
    return extractArticlesFromRSS(xml).map(a => a.text).join(' ');
}

/**
 * Split an RSS body into one record per <item>, keeping the metadata callers
 * need for downstream persistence (news table) alongside the joined title+
 * description text the Ollama NER pass consumes.
 */
interface RssArticle {
    text:    string;
    title?:  string;
    link?:   string;
    pubDate?: string;
    source?: string;
}

function extractArticlesFromRSS(xml: string, sourceHint?: string): RssArticle[] {
    const items: RssArticle[] = [];
    const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
    const tagRegex = /<[^>]+>/g;

    // Decode the handful of XML entities that show up in RSS titles/descriptions
    // ("&amp;", "&#39;", numeric refs). Enough for headline text — we're not
    // trying to be a full XML parser here.
    const decodeEntities = (s: string): string => s
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g,  "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(xml)) !== null) {
        const itemBody = itemMatch[1];
        const titleMatch   = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(itemBody);
        const descMatch    = /<description[^>]*>([\s\S]*?)<\/description>/i.exec(itemBody);
        const linkMatch    = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(itemBody);
        const pubDateMatch = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(itemBody);
        const sourceMatch  = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(itemBody);

        const parts: string[] = [];
        const title = titleMatch ? decodeEntities(titleMatch[1].replace(tagRegex, ' ').replace(/\s+/g, ' ').trim()) : undefined;
        if (title) parts.push(title);
        if (descMatch) parts.push(descMatch[1].replace(tagRegex, ' '));
        const text = decodeEntities(parts.join(' ').replace(/\s+/g, ' ').trim());
        if (!text) continue;

        const linkRaw = linkMatch ? linkMatch[1].replace(tagRegex, ' ').trim() : undefined;
        const link    = linkRaw && /^https?:\/\//i.test(linkRaw) ? linkRaw : undefined;
        const pubDate = pubDateMatch ? pubDateMatch[1].trim() : undefined;
        const source  = sourceMatch ? decodeEntities(sourceMatch[1].replace(tagRegex, ' ').trim()) : sourceHint;

        items.push({ text, title, link, pubDate, source });
    }
    return items;
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
 * Result bundle from the primary discovery pass — exposes both the regex-
 * derived tickers and the per-article raw text. Article text is reused by the
 * Ollama NER pass so we don't re-fetch any feeds.
 */
interface PrimaryDiscoveryResult {
    tickers: Set<string>;
    articleTexts: string[];
    /** Rich article records (RSS only). Used by both the Ollama NER pass and
     *  news-table persistence — text goes to Ollama, link/pubDate/source get
     *  written alongside the extracted event_type. JSON/SEC-sourced entries
     *  are omitted because they lack per-article metadata. */
    articles: RssArticle[];
}

/**
 * Fetch all primary feeds concurrently and return a combined set of tickers
 * plus the per-article text snippets gathered along the way.
 */
async function fetchPrimaryTickers(): Promise<PrimaryDiscoveryResult> {
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
                return { type: 'sec_form_4_xml', data: body, url };
            } else if (contentType.includes('application/json') || body.trim().startsWith('{')) {
                try {
                    return { type: 'json', data: JSON.parse(body), url };
                } catch {
                    return { type: 'rss', data: body, url };
                }
            }
            return { type: 'rss', data: body, url };
        } catch (err) {
            logger.warn(`Failed to fetch primary source: ${url}`, { error: String(err) });
            return null;
        }
    }));

    const allTickers = new Set<string>();
    const articleTexts: string[] = [];
    const articles: RssArticle[] = [];

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            const { type, data, url } = result.value as { type: string; data: any; url: string };
            let sourceHint: string | undefined;
            try {
                sourceHint = new URL(url).hostname;
            } catch { /* ignore malformed URLs — sourceHint stays undefined */ }

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
                        const parts: string[] = [];
                        if (typeof h  === 'string') { chunks.push(h);  parts.push(h);  }
                        if (typeof sh === 'string') { chunks.push(sh); parts.push(sh); }
                        if (typeof d  === 'string') { chunks.push(d);  parts.push(d);  }
                        const joined = parts.join(' ').trim();
                        if (joined) articleTexts.push(joined);
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
                const items = extractArticlesFromRSS(data, sourceHint);
                for (const item of items) {
                    articleTexts.push(item.text);
                    articles.push(item);
                    for (const ticker of extractTickers(item.text)) {
                        allTickers.add(ticker);
                    }
                }
            }
        }
    }
    return { tickers: allTickers, articleTexts, articles };
}

/**
 * Persist RSS articles (title/link/pubDate/source) into the `news` table,
 * attaching the per-article event_type extracted by the Ollama NER pass when
 * available. Runs once per discovery pass; safe to call with an empty pass.
 *
 * Idempotent by news.link (UNIQUE). Only rows with a valid http(s) link are
 * written — links are the dedup key, and rows without one would collide.
 * The event_type column is added on-demand (module-level guard) so we don't
 * hammer the schema on every request.
 */
let _newsEventTypeColumnEnsured = false;

async function persistNewsArticles(
    articles: RssArticle[],
    eventTypes: (string | null)[] | null,
): Promise<void> {
    if (articles.length === 0) return;
    const pool = await getDbConnection();

    if (!_newsEventTypeColumnEnsured) {
        try {
            await pool.query("ALTER TABLE news ADD COLUMN event_type VARCHAR(32) NULL");
        } catch (err: any) {
            // MySQL errno 1060 = duplicate column — expected on re-runs.
            if (err?.errno !== 1060) {
                logger.warn('news.event_type column ensure failed', { error: String(err) });
                // Bail out — without the column, the INSERT below will fail.
                return;
            }
        }
        _newsEventTypeColumnEnsured = true;
    }

    // Normalise a raw <pubDate> string ("Tue, 14 Jul 2026 12:00:00 GMT") into
    // MySQL DATETIME. Invalid or missing dates persist as NULL.
    const toMysqlDate = (raw?: string): string | null => {
        if (!raw) return null;
        const t = Date.parse(raw);
        if (Number.isNaN(t)) return null;
        return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    };

    let written = 0;
    for (let i = 0; i < articles.length; i++) {
        const a = articles[i];
        if (!a.link) continue;
        const eventType = eventTypes ? (eventTypes[i] ?? null) : null;
        const title  = (a.title || a.text).slice(0, 512);
        const link   = a.link.slice(0, 1024);
        const source = a.source ? a.source.slice(0, 255) : null;
        try {
            await pool.query(
                `INSERT INTO news (title, link, pub_date, source, event_type)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     title      = VALUES(title),
                     pub_date   = COALESCE(VALUES(pub_date), pub_date),
                     source     = COALESCE(VALUES(source), source),
                     event_type = COALESCE(VALUES(event_type), event_type)`,
                [title, link, toMysqlDate(a.pubDate), source, eventType],
            );
            written += 1;
        } catch (err) {
            // Silent per-row failure — mainly guards against oversized strings
            // or transient DB errors that shouldn't nuke the whole batch.
            logger.warn('news row insert failed', { link, error: String(err) });
        }
    }
    logger.info('news persisted', { attempted: articles.length, written });
}

/**
 * Secondary discovery pass: query Yahoo ticker-specific feeds.
 */
async function fetchSecondaryTickers(primaryTickers: Set<string>): Promise<Set<string>> {
    if (primaryTickers.size === 0) return primaryTickers;

    // Cap secondary pass to avoid hammering Yahoo with hundreds of simultaneous
    // requests. Raised from 30 → 60 to roughly double the per-ticker-feed
    // mention pool before any downstream gate fires; cost is ~2x outbound
    // Yahoo RSS requests during the discovery pass.
    const MAX_SECONDARY = 60;
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
 * Pull Yahoo's most-active trending tickers directly via getTrendingStocks
 * (same source the /api/market/trending route uses). We bypass the HTTP route
 * because that route does heavy per-ticker enrichment (Yahoo summary + MA
 * lookups for every result) that timed out under our 15s budget when limit
 * went above ~50. We only need the symbols here; everything else is wasted
 * work for the discovery pass. Non-fatal: a failed Yahoo call returns an
 * empty set and the pipeline proceeds.
 */
async function fetchTrendingTickers(limit: number = 50): Promise<Set<string>> {
    const found = new Set<string>();
    try {
        const quotes = await getTrendingStocks(limit);
        for (const q of quotes as any[]) {
            const t = (q?.symbol || '').toUpperCase();
            if (t && !TICKER_STOPLIST.has(t)) found.add(t);
        }
    } catch (err) {
        logger.warn('Trending feed direct fetch failed', { error: String(err) });
    }
    return found;
}

/**
 * Pull upcoming-earnings tickers from the NASDAQ calendar API for the next
 * `businessDays` sessions (weekends skipped). Companies about to report tend
 * to see elevated volatility and analyst attention; injecting them here
 * ensures the ranker gets a look before the print rather than the day after.
 * A single-day failure is non-fatal — we surface whatever the successful
 * calls returned.
 *
 * Returns both the merged ticker set and a plain array so the API can echo
 * the raw list back to callers (deepmoney_sync uses it to backfill the
 * `stocks` master table for tickers that don't survive the analyzer).
 */
async function fetchEarningsCalendarTickers(
    businessDays: number = 5,
): Promise<{ tickers: Set<string>; entries: { symbol: string; name: string }[] }> {
    const found = new Set<string>();
    const nameBySymbol = new Map<string, string>();
    const dates: string[] = [];
    const cursor = new Date();
    while (dates.length < businessDays) {
        const day = cursor.getUTCDay(); // 0 = Sun, 6 = Sat
        if (day !== 0 && day !== 6) {
            dates.push(cursor.toISOString().slice(0, 10));
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // NASDAQ blocks generic UAs — use a real browser string. Timeout is per
    // day so a single hung request can't stall the whole discovery pass.
    const headers: HeadersInit = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
    };

    const results = await Promise.allSettled(dates.map(async (date) => {
        const res = await fetch(
            `https://api.nasdaq.com/api/calendar/earnings?date=${date}`,
            { headers, signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) throw new Error(`nasdaq earnings ${date} returned ${res.status}`);
        return res.json();
    }));

    for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const rows = r.value?.data?.rows;
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
            const t = (row?.symbol || '').toUpperCase().trim();
            if (!t || TICKER_STOPLIST.has(t)) continue;
            found.add(t);
            // First non-empty name wins across days — company_name doesn't
            // change between reporting dates, so no dedup logic needed.
            if (!nameBySymbol.has(t)) {
                const name = String(row?.name || '').trim();
                if (name) nameBySymbol.set(t, name);
            }
        }
    }
    const entries = Array.from(found).sort().map((symbol) => ({
        symbol,
        name: nameBySymbol.get(symbol) || symbol,
    }));
    return { tickers: found, entries };
}

/**
 * Pull the top ~25 sector leaders per canonical Yahoo sector via the
 * ms_<sector> predefined screener. Powers GPS coverage on the
 * /search/industry/[sector] page — every leader needs a fresh GPS row in
 * stock_gps_scores so the UI can render the canonical sector tile without
 * computing on-demand. A single-sector failure is non-fatal.
 */
async function fetchSectorLeaderTickers(): Promise<Set<string>> {
    const found = new Set<string>();
    const results = await Promise.allSettled(CANONICAL_SECTORS.map(async (sector) => {
        const quotes = await getSectorStocks(sector, 25);
        return (quotes as any[]).map((q: any) => q.symbol).filter(Boolean);
    }));
    for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const sym of r.value) {
            const t = (sym || '').toUpperCase();
            if (t && !TICKER_STOPLIST.has(t)) found.add(t);
        }
    }
    return found;
}

/**
 * Given a set of sector-leader tickers, return only those whose
 * `stock_gps_scores.as_of` is missing or older than `freshDays`. These are
 * the tickers the analyzer must run MC + GPS on to refresh; the rest still
 * have a valid recent score and can be skipped.
 *
 * Returns the input set on DB failure (degraded-mode: re-compute everything).
 */
async function filterStaleSectorLeaders(
    tickers: Set<string>,
    freshDays: number = 7,
): Promise<Set<string>> {
    if (tickers.size === 0) return new Set();
    try {
        const pool = await getDbConnection();
        const [rows] = await pool.query(
            `SELECT s.symbol, sgs.as_of
             FROM stocks s
             LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = s.id
             WHERE s.symbol IN (?)`,
            [Array.from(tickers)],
        ) as any;
        const freshBy = Date.now() - freshDays * 24 * 60 * 60 * 1000;
        const fresh = new Set<string>();
        for (const r of rows) {
            if (r.as_of && new Date(r.as_of).getTime() >= freshBy) {
                fresh.add(r.symbol);
            }
        }
        const stale = new Set<string>();
        for (const t of tickers) {
            if (!fresh.has(t)) stale.add(t);
        }
        return stale;
    } catch (err) {
        logger.warn('filterStaleSectorLeaders DB query failed — falling back to re-compute all', { error: String(err) });
        return tickers;
    }
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

    // Request the route's max holdings per ETF (currently 20, hard-capped in
    // the route). Pulls more candidates into the discovery pool without
    // touching downstream gates (topNEtfs, etfGpsThreshold, gpsSurfaceValue).
    const HOLDINGS_PER_ETF = 20;
    const results = await Promise.allSettled(etfTickers.map(async (etf) => {
        const res = await fetch(`${baseUrl}/api/stock_data/${encodeURIComponent(etf)}/holdings?limit=${HOLDINGS_PER_ETF}`, {
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

// Per-ticker enrichment cache. Enrichment is 3 Yahoo calls per ticker (quote
// summary, 1y chart, fundamentals timeseries) and is by far the outbound-HTTP
// hotspot for the sync. A 30-min TTL means back-to-back deepmoney passes
// (news pass + holdings pass in the same route call, or a sync that reruns
// within the window) skip the fetch entirely for tickers already enriched.
// Fundamentals rarely change intraday; sectors/PE/market cap never do.
const ENRICHMENT_TTL_MS = 30 * 60 * 1000;
const enrichmentCache: Map<string, { enriched: any; cachedAt: number }> = new Map();

/**
 * Enrich a list of tickers with fundamental and technical metrics.
 * Processes all tickers in small batches to avoid overwhelming the API.
 * Reads from a 30-min in-memory cache first; only uncached tickers hit Yahoo.
 */
async function enrichTickers(tickers: string[]) {
    //logger.info(`Enriching ${tickers.length} tickers with metrics (Full Sweep)`);

    const now = Date.now();
    const results: any[] = [];
    const uncached: string[] = [];
    for (const t of tickers) {
        const hit = enrichmentCache.get(t);
        if (hit && (now - hit.cachedAt) < ENRICHMENT_TTL_MS) {
            results.push(hit.enriched);
        } else {
            uncached.push(t);
        }
    }
    if (results.length > 0) {
        logger.info(`enrichTickers cache: ${results.length}/${tickers.length} hit, ${uncached.length} to fetch`);
    }

    // 6 tickers × 3 Yahoo calls = 18 concurrent requests per batch.
    // Halved from 12 to reduce CPU burst spikes on the VPS during sync.
    const BATCH_SIZE = 6;

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
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

                const marketCap = price.marketCap || detail.marketCap || 0;
                const currentPrice = price.regularMarketPrice || 0;
                // Technical & Growth calculations
                const revenueGrowth = financial.revenueGrowth || 0;
                const earningsGrowth = financial.earningsGrowth || 0;
                const analystTarget = financial.targetMeanPrice || 0;
                const analystUpside = analystTarget > 0 ? (analystTarget - currentPrice) / currentPrice : 0;

                // Compute the full analyst grade (A+ → F-) for the analyst-grade
                // override lane in analyzer.ts. Uses the 4-period recommendation
                // trend + price target bounds — all already fetched above.
                const rawTrend = ((summary as any).recommendationTrend?.trend ?? []) as Array<any>;
                const analystTrend: RecommendationPeriod[] = rawTrend
                    .filter((t: any) => typeof t.period === 'string')
                    .map((t: any) => ({
                        period:     t.period,
                        strongBuy:  t.strongBuy  ?? 0,
                        buy:        t.buy        ?? 0,
                        hold:       t.hold       ?? 0,
                        sell:       t.sell       ?? 0,
                        strongSell: t.strongSell ?? 0,
                    }));
                const analystPriceTarget = {
                    low:  (financial.targetLowPrice  as number | null) ?? null,
                    mean: (financial.targetMeanPrice as number | null) ?? null,
                    high: (financial.targetHighPrice as number | null) ?? null,
                };
                const analystGradeResult = computeAnalystGrade(analystTrend, analystPriceTarget, currentPrice || null);
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
                    analystGradeComposite: analystGradeResult?.composite ?? null,
                    analystGrade: analystGradeResult?.grade ?? null,
                    sma20: tech?.sma20 || null,
                    sma50: tech?.sma50 || null,
                    rsi: tech?.rsi14 || null,
                    tradingSignal: tech?.signal || 'Hold',
                    tradingSignalScore: tech?.scoreBreakdown.totalScore || 0,
                    signalStrength: tech?.signalStrength || 0,
                    sector: profile.sector || 'Unknown',
                    industry: profile.industry || null
                    };            } catch (err) {

                logger.warn(`Failed to enrich ${ticker}`, { error: String(err) });
                return { ticker, name: ticker, error: 'Enrichment failed' };
            }
        }));
        // Only cache successful enrichments — failed rows should be retried
        // next call rather than pinned to the cache for 30 min.
        const cacheStamp = Date.now();
        for (const row of batchResults) {
            if (row && !row.error) {
                enrichmentCache.set(row.ticker, { enriched: row, cachedAt: cacheStamp });
            }
        }
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
        const [wbData, primaryResult] = await Promise.all([
            fetchWorldBankData(forceRefresh),
            fetchPrimaryTickers()
        ]);
        const primaryTickers = primaryResult.tickers;
        const primaryArticleTexts = primaryResult.articleTexts;
        const primaryArticles     = primaryResult.articles;
        
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

        // Persist news articles — event_type stays NULL (NER classifier removed).
        try {
            await persistNewsArticles(primaryArticles, null);
        } catch (err) {
            logger.warn('news persistence failed', { error: String(err) });
        }

        // --- Merge popular-ETF holdings + Trending + Sector leaders ---
        // Set semantics dedup automatically with feed-discovered tickers.
        // Sector leaders are the top-25 by market-cap for each of the 11 canonical
        // Yahoo sectors; injected so /search/industry/[sector] always has fresh GPS.
        // (Yahoo earnings-calendar HTML scrape removed: Cloudflare bot-block
        // made it return zero tickers while burning a 15s timeout per run.)
        const [popularEtfHoldingTickers, trendingTickers, sectorLeaderTickers, earningsCalendarResult] = await Promise.all([
            fetchEtfHoldingTickers(POPULAR_ETF_TICKERS),
            fetchTrendingTickers(100),
            fetchSectorLeaderTickers(),
            fetchEarningsCalendarTickers(5),
        ]);
        const earningsCalendarTickers = earningsCalendarResult.tickers;
        for (const t of popularEtfHoldingTickers) allTickersSet.add(t);
        for (const t of trendingTickers) allTickersSet.add(t);
        for (const t of sectorLeaderTickers) allTickersSet.add(t);
        for (const t of earningsCalendarTickers) allTickersSet.add(t);

        // Freshness gate: skip MC + GPS for sector leaders that already have a
        // GPS row newer than 7 days. Steady-state, this drops the override-lane
        // workload from ~275 to ~20-40 per nightly run.
        const staleSectorLeaderTickers = await filterStaleSectorLeaders(sectorLeaderTickers, 7);
        logger.info(`Sector leaders: ${sectorLeaderTickers.size} injected, ${staleSectorLeaderTickers.size} stale (need MC+GPS), ${sectorLeaderTickers.size - staleSectorLeaderTickers.size} skipped fresh`);

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
        const {
            stocks: filteredStocks,
            rankerSurvivorCount,
            rankerFellThrough,
            lightModelPassedCount,
            lightModelFilteredCount,
        } = await analyzeStocks(
            enrichedStocks,
            { wbData, marketIndices },
            {
                outlook,
                mlGate,
                rankerKeepPct: algorithm.rankerKeepPct,
                signalScoreFloor: algorithm.signalScoreFloor,
                sectorLeaderTickers: staleSectorLeaderTickers,
                trendingTickers,
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
                // Full ticker list from the NASDAQ earnings calendar (next 5
                // business days). deepmoney_sync.py backfills these into the
                // `stocks` master table even when they don't survive the
                // analyzer, so search + earnings widgets can resolve them.
                // Entries carry {symbol, name} so the stocks-table insert
                // can satisfy the NOT NULL company_name column.
                earningsCalendarTickers: earningsCalendarResult.entries,
                earningsCalendarCount:   earningsCalendarResult.entries.length,
                feedsQueried: PRIMARY_FEED_URLS.length + primaryTickers.size,
                // Resolved DEEPMONEY_ALGORITHM preset. deepmoney_sync.py reads
                // back from here — it is the only knob for run aggressiveness.
                algorithm,
                ollamaPass: null,
                debug: {
                    rejectedEnrichment: enrichedStocks.filter(s => s.error).length,
                    rejectedSignalScore: enrichedStocks.filter(s => !s.error && (s.tradingSignalScore === undefined || s.tradingSignalScore < algorithm.signalScoreFloor)).length,
                    rejectedHistory: enrichedStocks.filter(s => !s.error && s.tradingSignalScore !== undefined && s.tradingSignalScore >= algorithm.signalScoreFloor && s.historyRows < 100).length,
                    passedToAnalyzer: enrichedStocks.filter(s => !s.error && s.tradingSignalScore !== undefined && s.tradingSignalScore >= algorithm.signalScoreFloor && s.historyRows >= 100).length,
                    rejectedByRanker: enrichedStocks.filter(s => !s.error && s.tradingSignalScore !== undefined && s.tradingSignalScore >= algorithm.signalScoreFloor && s.historyRows >= 100).length - filteredStocks.length,
                    rankerSurvivorCount,
                    rankerFellThrough,
                    lightModelPassed:   lightModelPassedCount,
                    lightModelFiltered: lightModelFilteredCount,
                    filteredCount: filteredStocks.length,
                    predictionThreshold: `${mlGate}%`,
                    analystConsensusSurfaced: filteredStocks.filter(s => s.discovery_source === 'analyst_consensus').length,
                    trending48hSurfaced: filteredStocks.filter(s => s.discovery_source === 'trending_48h').length,
                    sectorLeadersSurfaced: filteredStocks.filter(s => s.discovery_source === 'sector_leader').length,
                    sectorLeadersInjected: sectorLeaderTickers.size,
                    earningsCalendarInjected: earningsCalendarTickers.size,
                    sectorLeadersSkippedFresh: sectorLeaderTickers.size - staleSectorLeaderTickers.size,
                    sectorLeadersComputed: staleSectorLeaderTickers.size,
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
