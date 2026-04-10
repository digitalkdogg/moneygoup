import { NextResponse, NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
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

const logger = createLogger('api/prediction/deepmoney');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const sentiment = new Sentiment();
const xmlParser = new XMLParser();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEY = 'hot-tickers-enriched';
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
    'https://apewisdom.io/api/v1.0/filter/all-stocks',
    'https://feeds.feedburner.com/typepad/alleyinsider/silicon_alley_insider', // Tech
    'https://www.fiercebiotech.com/rss/xml',                                   // Biotech
    'https://www.fierceelectronics.com/rss/xml',                               // Semiconductors
    'https://www.spacenews.com/feed/',                                         // Aerospace/Defense
    'https://ir.stockanalysis.com/feed/',                                      // Small/Mid cap
];

const YAHOO_TICKER_FEED_BASE = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=';

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
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) {
         //   logger.warn(`Feed returned ${res.status}: ${url}`);
            return null;
        }
        return await res.text();
    } catch (err) {
        logger.error(`Failed to fetch feed: ${url}`, err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) });
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
                signal: AbortSignal.timeout(8_000),
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

    const secondaryUrls = Array.from(primaryTickers).map(
        (ticker) => `${YAHOO_TICKER_FEED_BASE}${encodeURIComponent(ticker)}`
    );

    logger.info(`Running secondary pass for ${primaryTickers.size} tickers`);
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
 * Enrich a list of tickers with fundamental and technical metrics.
 * Processes all tickers in small batches to avoid overwhelming the API.
 */
async function enrichTickers(tickers: string[]) {
    //logger.info(`Enriching ${tickers.length} tickers with metrics (Full Sweep)`);

    const results: any[] = [];
    const BATCH_SIZE = 5; // Process 5 tickers concurrently to avoid rate limits
    
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
        const batch = tickers.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (ticker) => {
            try {
                const [summary, historical, newsRes] = await Promise.all([
                    yahooFinance.quoteSummary(ticker, {
                        modules: ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'price', 'incomeStatementHistory', 'assetProfile']
                    }).catch(() => null),
                    yahooFinance.historical(ticker, {
                        period1: oneYearAgo,
                        period2: yesterday
                    }).catch(() => []),
                    fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`).then(r => r.ok ? r.text() : null).catch(() => null)
                ]);

                if (!summary) return { ticker, name: ticker, error: 'No summary data' };

                const detail = (summary as any).summaryDetail || {};
                const financial = (summary as any).financialData || {};
                const stats = (summary as any).defaultKeyStatistics || {};
                const price = (summary as any).price || {};
                const income = (summary as any).incomeStatementHistory?.incomeStatementHistory?.[0] || {};
                const profile = (summary as any).assetProfile || {};

                const marketCap = price.marketCap || detail.marketCap || 0;
                const currentPrice = price.regularMarketPrice || 0;
                // Technical & Growth calculations
                const revenueGrowth = financial.revenueGrowth || 0;
                const earningsGrowth = financial.earningsGrowth || 0;
                const analystTarget = financial.targetMeanPrice || 0;
                const analystUpside = analystTarget > 0 ? (analystTarget - currentPrice) / currentPrice : 0;
                const fiftyTwoWeekChange = stats.fiftyTwoWeekChange || 0;

                const histData = (historical || []).map(r => ({
                    date: new Date(r.date).toISOString().slice(0, 10),
                    open: r.open || 0,
                    high: r.high || 0,
                    low: r.low || 0,
                    close: r.adjClose || r.close || 0,
                    volume: r.volume || 0
                }));

                const tech = histData.length >= 20 
                    ? calculateTechnicalIndicators(histData, [], detail.trailingPE || stats.forwardPE, stats.priceToBook, marketCap)
                    : null;

                return {
                    ticker,
                    name: price.longName || price.shortName || ticker,
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
                    researchDevelopment: income.researchDevelopment || 0,
                    totalRevenue: financial.totalRevenue || 1,
                    fiftyTwoWeekChange: fiftyTwoWeekChange,
                    analystUpside: analystUpside,
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
    const apiKey = request.headers.get('x-api-key');
    const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
    const isInternal = apiKey && apiKey === internalSecret;

    if (!isInternal) {
        const originCheckResponse = checkOrigin(request as any);
        if (originCheckResponse) return originCheckResponse;

        const session = await getServerSession(authOptions);
        if (!session) {
            logger.warn('Unauthenticated request to hot-tickers endpoint');
            return unauthorizedResponse();
        }
    }

    // --- Rate limiting ---
    const clientIP = getClientIP(request);
    const rateLimitResult = await deepmoneyLimiter.check(isInternal ? 'internal' : clientIP);
    if (!rateLimitResult.allowed) {
        logger.warn(`Rate limit exceeded for ${isInternal ? 'internal' : clientIP}`);
        return forbiddenResponse('Rate limit exceeded. Please try again later.');
    }

    // --- Cache check ---
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';

    if (!forceRefresh) {
        const cached = deepmoneyCache.get(CACHE_KEY);
        if (cached) {
            logger.info('Returning cached enriched hot tickers');
            return NextResponse.json(cached);
        }
    } else {
        logger.info('DeepMoney V2 force refresh requested');
    }


    try {
        logger.info('Starting primary RSS feed pass');
        const primaryTickers = await fetchPrimaryTickers();
        const allTickersSet = await fetchSecondaryTickers(primaryTickers);
        

        const tickerArray = Array.from(allTickersSet).sort();

        // --- Metric Enrichment ---
        const enrichedStocks = await enrichTickers(tickerArray);

        // --- Analysis Filtering ---
        const filteredStocks = await analyzeStocks(enrichedStocks);

        const data = {
            success: true,
            timestamp: new Date().toISOString(),
            count: filteredStocks.length,
            stocks: filteredStocks,
            meta: {
                totalDiscovered: tickerArray.length,
                enrichedCount: enrichedStocks.length,
                filteredCount: filteredStocks.length,
                primaryCount: primaryTickers.size,
                secondaryCount: allTickersSet.size - primaryTickers.size,
                feedsQueried: PRIMARY_FEED_URLS.length + primaryTickers.size,
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