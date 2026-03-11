import nlp from 'compromise';
import Sentiment from 'sentiment';
import { getNews } from './getNews';
import { fetchYahooStockSummary, getYahooScreener } from '@/utils/yahooFinanceHelper';
import { performETFDiscovery } from '@/utils/etfDiscovery';
import { calculateTechnicalIndicators } from '@/utils/technicalIndicators';
import watchlist from '@/../public/ai_tech_watchlist.json';
import {
  AI_TECH_TAXONOMY,
  BROAD_INDUSTRIES,
  PRICE_FILTER_MAX,
  GPS_WEIGHTS,
  AI_TECH_BONUS,
  SCREENER_THRESHOLDS,
  COMPANY_FEED_BASE_URL,
  MAX_COMPANY_FEED_FETCHES,
  CO_MENTION_SENTIMENT_WEIGHT,
  resolveTicker
} from './config';

const sentiment = new Sentiment();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TickerMention {
  count: number;
  sentiment: number;
  subSectors: Set<string>;
  keywords: number;
  /** Tickers whose company-level RSS feed surfaced this entry (Pass 2 only) */
  coMentionedWith: Set<string>;
  /** True when first discovered via a company-level feed rather than index feeds */
  fromCompanyFeed: boolean;
}

// ---------------------------------------------------------------------------
// Stage 2.5 Helper — fetch & parse a single company RSS feed
// ---------------------------------------------------------------------------

/**
 * Fetches the Yahoo Finance headline RSS feed for `sourceTicker`, extracts
 * every organisation mention, resolves them to tickers, and returns a map of
 * ticker → partial TickerMention data (excluding the source ticker itself).
 *
 * Sentiment scores are multiplied by CO_MENTION_SENTIMENT_WEIGHT because the
 * association is indirect (Company B mentioned in Company A's feed).
 */
async function fetchCompanyFeedMentions(
  sourceTicker: string
): Promise<{ [ticker: string]: Omit<TickerMention, 'fromCompanyFeed'> }> {
  const url = `${COMPANY_FEED_BASE_URL}${encodeURIComponent(sourceTicker)}`;
  const discovered: { [ticker: string]: Omit<TickerMention, 'fromCompanyFeed'> } = {};

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`Company feed fetch failed for ${sourceTicker}: HTTP ${res.status}`);
      return discovered;
    }

    const xml = await res.text();

    // Pull <title> and <description> text out of each <item> with a simple regex
    // (avoids importing a full XML parser for what is a well-structured feed).
    const itemRegex = /<item[\s\S]*?<\/item>/gi;
    const titleRegex = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i;
    const descRegex = /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i;

    const items = xml.match(itemRegex) || [];

    for (const item of items) {
      const titleMatch = item.match(titleRegex);
      const descMatch = item.match(descRegex);
      const titleText = (titleMatch?.[1] ?? titleMatch?.[2] ?? '').trim();
      const descText = (descMatch?.[1] ?? descMatch?.[2] ?? '').trim();
      const text = (titleText + ' ' + descText).toLowerCase();

      const doc = nlp(text);
      const organizations: string[] = doc.organizations().out('array');
      const sentimentResult = sentiment.analyze(text);
      const weightedScore = sentimentResult.score * CO_MENTION_SENTIMENT_WEIGHT;

      // Sub-sector detection for this article
      const foundSubSectors = new Set<string>();
      let keywordCount = 0;
      for (const [subSector, keywords] of Object.entries(AI_TECH_TAXONOMY)) {
        if (keywords.some(k => text.includes(k))) {
          foundSubSectors.add(subSector);
          keywordCount++;
        }
      }

      for (const org of organizations) {
        const ticker = resolveTicker(org);

        // Skip if unresolvable, or if it's the ticker whose feed we're reading
        if (!ticker || ticker === sourceTicker) continue;

        if (!discovered[ticker]) {
          discovered[ticker] = {
            count: 0,
            sentiment: 0,
            subSectors: new Set(),
            keywords: 0,
            coMentionedWith: new Set()
          };
        }

        discovered[ticker].count++;
        discovered[ticker].sentiment += weightedScore;
        foundSubSectors.forEach(s => discovered[ticker].subSectors.add(s));
        discovered[ticker].keywords += keywordCount;
        discovered[ticker].coMentionedWith.add(sourceTicker);
      }
    }
  } catch (err) {
    console.error(`Error fetching company feed for ${sourceTicker}:`, err);
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Data Fetching Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the complete 5-year data payload for the Prediction Engine.
 * Includes OHLCV, macro series (VIX, 10Y, Sector ETF), and fundamentals.
 */
async function fetchCompleteStockData(ticker: string) {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
  const url = `${baseUrl}/api/stock_data/${ticker}/data`;
  
  try {
    const res = await fetch(url, {
      headers: {
        'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '',
      },
      signal: AbortSignal.timeout(15000), // 15s timeout for heavy assembly
    });

    if (!res.ok) {
      console.warn(`Complete data fetch failed for ${ticker}: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error(`Error fetching complete data for ${ticker}:`, err);
    return null;
  }
}

/**
 * Fetches ticker-specific news from the internal API.
 */
async function fetchTickerNews(ticker: string) {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
  const url = `${baseUrl}/api/stock_data/${ticker}/news`;
  
  try {
    const res = await fetch(url, {
      headers: {
        'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`Ticker news fetch failed for ${ticker}: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    return data.articles?.[ticker] || [];
  } catch (err) {
    console.error(`Error fetching news for ${ticker}:`, err);
    return [];
  }
}

/**
 * Fetches quarterly historical earnings data for a ticker.
 */
async function fetchTickerEarnings(ticker: string) {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
  const url = `${baseUrl}/api/stock_data/${ticker}/earnings`;
  
  try {
    const res = await fetch(url, {
      headers: {
        'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`Ticker earnings fetch failed for ${ticker}: HTTP ${res.status}`);
      return { upcomingEarnings: null, historicalEarnings: [] };
    }

    return await res.json();
  } catch (err) {
    console.error(`Error fetching earnings for ${ticker}:`, err);
    return { upcomingEarnings: null, historicalEarnings: [] };
  }
}

// ---------------------------------------------------------------------------
// Scoring & Enrichment Logic
// ---------------------------------------------------------------------------

async function enrichAndScore(
  ticker: string,
  mentions: number,
  avgSentiment: number,
  subSectors: string[],
  keywordDensity: number,
  isWatchlist: boolean = false,
  coMentionedWith: string[] = [],
  tickerNewsArticles: { sentiment_score: number; pub_date: string }[] = []
) {
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const historicalUrl = `${baseUrl}/api/stock_data/${ticker}/historical/3mo`;

    const [summary, historicalRes] = await Promise.all([
      fetchYahooStockSummary(ticker),
      fetch(historicalUrl, {
        headers: { 'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '' },
        signal: AbortSignal.timeout(10000)
      }).then(res => res.ok ? res.json() : null).catch(() => null)
    ]);

    const price = summary.price?.regularMarketPrice;

    // 1. Price Filter Hard Gate
    if (!price || price >= PRICE_FILTER_MAX) return null;

    const marketCap = summary.price?.marketCap || 0;

    // Market cap hard gates
    if (marketCap < SCREENER_THRESHOLDS.MARKET_CAP_FLOOR || marketCap > SCREENER_THRESHOLDS.MARKET_CAP_CEILING) return null;

    const financialData = summary.financialData;
    const stats = summary.defaultKeyStatistics;
    const profile = summary.assetProfile;
    const income = summary.incomeStatementHistory?.incomeStatementHistory?.[0];

    // 1.5 Technical Analysis Signal Gate
    const historicalData = (historicalRes?.historicalData?.[ticker] || []) as any[];
    const technicalResult = historicalData.length >= 51
      ? calculateTechnicalIndicators(
          historicalData,
          tickerNewsArticles,
          (financialData?.forwardPE ?? stats?.forwardPE) as number | undefined,
          stats?.priceToBook as number | undefined,
          marketCap as number | undefined
        )
      : null;

    const tradingSignalScore = technicalResult?.scoreBreakdown.totalScore ?? 0;
    const tradingSignal = technicalResult?.signal ?? 'HOLD';

    // HARD GATE: discard stocks unless they have a positive trading signal (> 0)
    if (tradingSignalScore <= 0) {
      if (ticker === 'CRM' || ticker === 'NDAQ' || ticker === 'VRT') {
        console.log(`[DeepMoney] Skipping ${ticker}: TechScore=${tradingSignalScore}, Signal=${tradingSignal}. Breakdown: MA=${technicalResult?.scoreBreakdown.maScore}, RSI=${technicalResult?.scoreBreakdown.rsiScore}, Mom=${technicalResult?.scoreBreakdown.momentumScore}, News=${technicalResult?.scoreBreakdown.newsScore}, Core=${technicalResult?.scoreBreakdown.coreMetricsScore}`);
      }
      return null;
    }

    const revenueGrowth = financialData?.revenueGrowth || 0;
    const earningsGrowth = financialData?.earningsGrowth || 0;
    const epsGrowth =
      stats?.forwardEps && stats?.trailingEps
        ? (stats.forwardEps - stats.trailingEps) / Math.abs(stats.trailingEps || 1)
        : 0;
    const fiftyTwoWeekChange = (stats?.fiftyTwoWeekChange as number) || 0;
    const analystUpside = financialData?.targetMeanPrice
      ? (financialData.targetMeanPrice - price) / price
      : 0;
    const grossMargin = financialData?.grossMargins || 0;
    const rdSpend = income?.researchDevelopment || 0;
    const revenue = financialData?.totalRevenue || 1;
    const rdSpendPct = rdSpend / revenue;

    // 2. Growth Classification
    let classification = 'standard';
    const isTech =
      profile?.sector === 'Technology' || profile?.sector === 'Communication Services';

    if (isTech && revenueGrowth >= 0.20 && grossMargin >= 0.50 && rdSpendPct >= 0.10) {
      classification = 'ai_tech_hyper_growth';
    } else if (revenueGrowth >= 0.10 && epsGrowth > 0 && fiftyTwoWeekChange >= 0.10) {
      classification = 'established_growth';
    } else if (
      revenueGrowth >= 0.15 &&
      marketCap >= 300e6 &&
      marketCap <= 10e9 &&
      analystUpside >= 0.15
    ) {
      classification = 'up_and_coming_stable';
    }

    // 3. Base GPS Score
    let gps = 0;
    gps += Math.min(Math.max(analystUpside / 0.3, 0), 1) * 100 * GPS_WEIGHTS.ANALYST_UPSIDE;
    gps += Math.min(Math.max(revenueGrowth / 0.3, 0), 1) * 100 * GPS_WEIGHTS.REVENUE_GROWTH;
    gps += Math.min(Math.max(earningsGrowth / 0.25, 0), 1) * 100 * GPS_WEIGHTS.EPS_GROWTH;
    gps += Math.min(Math.max(fiftyTwoWeekChange / 0.2, 0), 1) * 100 * GPS_WEIGHTS.MOMENTUM;
    gps += Math.min(mentions / 5, 1) * 100 * GPS_WEIGHTS.MENTIONS;
    gps += Math.min(Math.max((avgSentiment + 5) / 10, 0), 1) * 100 * GPS_WEIGHTS.SENTIMENT;

    // 4. AI/Tech Signal Bonus
    let bonus = 0;
    if (classification === 'ai_tech_hyper_growth') bonus += AI_TECH_BONUS.PROFILE_C;
    if (marketCap < SCREENER_THRESHOLDS.MARKET_CAP_CEILING) {
      if (subSectors.length > 0) bonus += AI_TECH_BONUS.SUB_SECTOR_SENTIMENT * subSectors.length;
      if (rdSpendPct >= 0.20) bonus += AI_TECH_BONUS.RD_SPEND_HIGH;
      if (keywordDensity >= 5) bonus += AI_TECH_BONUS.KEYWORD_DENSITY;
      if (marketCap < 5e9) bonus += AI_TECH_BONUS.SMALL_CAP;
    }

    const finalGps = Math.min(gps + bonus, 100);
    console.log(`[DeepMoney] Scored ${ticker}: GPS=${finalGps.toFixed(1)}, TechSignal=${tradingSignalScore}`);

    return {
      ticker,
      company_name: summary.price?.longName || summary.price?.shortName,
      current_price: price,
      gps_score: parseFloat(finalGps.toFixed(1)),
      classification,
      sub_sectors: subSectors,
      analyst_upside_pct: parseFloat((analystUpside * 100).toFixed(1)),
      revenue_growth_yoy: parseFloat((revenueGrowth * 100).toFixed(1)),
      gross_margin_pct: parseFloat((grossMargin * 100).toFixed(1)),
      rd_spend_pct: parseFloat((rdSpendPct * 100).toFixed(1)),
      market_cap_m: parseFloat((marketCap / 1e6).toFixed(1)),
      mention_count: mentions,
      co_mentioned_with: coMentionedWith,   // NEW — populated for Pass-2 discoveries
      discovery_source: 'keyword',           // overwritten by caller
      snapshot_date: new Date().toISOString().split('T')[0],
      trading_signal: tradingSignal,
      trading_signal_score: tradingSignalScore,
      signal_breakdown: technicalResult?.scoreBreakdown ?? null,
      stockMetrics: {
        peRatio:              stats?.forwardPE || financialData?.forwardPE,
        pbRatio:              stats?.priceToBook,
        trailingEps:          stats?.trailingEps,
        forwardEps:           stats?.forwardEps,
        revenueGrowth:        financialData?.revenueGrowth,
        earningsGrowth:       financialData?.earningsGrowth,
        profitMargins:        financialData?.profitMargins,
        debtToEquity:         financialData?.debtToEquity,
        returnOnEquity:       financialData?.returnOnEquity,
        beta:                 summary.price?.beta,
        dividendYield:        summary.summaryDetail?.dividendYield,
        marketCap:            marketCap,
        analystTargetMean:    financialData?.targetMeanPrice,
        analystOpinionCount:  financialData?.numberOfAnalystOpinions,
        recommendationMean:   financialData?.recommendationMean,
      }
    };
  } catch (e) {
    console.error(`Error enriching ${ticker}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main Analysis Entry Point
// ---------------------------------------------------------------------------

export async function performDeepAnalysis() {
  // -------------------------------------------------------------------------
  // Stage 1: News Analysis — index-level RSS feeds
  // -------------------------------------------------------------------------
  const newsData = await getNews();
  const articles = newsData.items || [];

  const tickerMentions: { [key: string]: TickerMention } = {};
  const tickerArticles: { [key: string]: { sentiment_score: number; pub_date: string }[] } = {};
  const industryStats: { [key: string]: { score: number; count: number } } = {};
  const aiSubSectorStats: { [key: string]: { score: number; count: number } } = {};

  for (const article of articles) {
    // FIX: use description as fallback — MarketBeat has no content field
    const text = (article.title + ' ' + (article.content || article.description || '')).toLowerCase();
    const sentimentResult = sentiment.analyze(text);

    // Sub-sector and industry detection — unchanged, runs for ALL articles
    const foundSubSectors = new Set<string>();
    let keywordCount = 0;
    for (const [subSector, keywords] of Object.entries(AI_TECH_TAXONOMY)) {
      if (keywords.some(k => text.includes(k))) {
        foundSubSectors.add(subSector);
        keywordCount++;
        if (!aiSubSectorStats[subSector]) aiSubSectorStats[subSector] = { score: 0, count: 0 };
        aiSubSectorStats[subSector].score += sentimentResult.score;
        aiSubSectorStats[subSector].count++;
      }
    }

    for (const [industry, keywords] of Object.entries(BROAD_INDUSTRIES)) {
      if (keywords.some(k => text.includes(k))) {
        if (!industryStats[industry]) industryStats[industry] = { score: 0, count: 0 };
        industryStats[industry].score += sentimentResult.score;
        industryStats[industry].count++;
      }
    }

    // Ticker resolution — branched by source
    const hasExplicitTickers = article.explicitTickers && article.explicitTickers.length > 0;

    const tickers: string[] = hasExplicitTickers
      ? article.explicitTickers  // MarketBeat: use category tags directly, skip NLP
      : nlp(text).organizations().out('array').map(resolveTicker).filter(Boolean) as string[];

    // Multi-ticker inflation guard: fractional credit when many tickers share one article
    const mentionIncrement = tickers.length > 1 ? 1 / tickers.length : 1;

    for (const ticker of tickers) {
      if (!ticker) continue;
      if (!tickerMentions[ticker]) {
        tickerMentions[ticker] = {
          count: 0,
          sentiment: 0,
          subSectors: new Set(),
          keywords: 0,
          coMentionedWith: new Set(),
          fromCompanyFeed: false
        };
      }
      if (!tickerArticles[ticker]) tickerArticles[ticker] = [];

      tickerMentions[ticker].count += mentionIncrement; // fractional for multi-ticker articles
      tickerMentions[ticker].sentiment += sentimentResult.score;
      foundSubSectors.forEach(s => tickerMentions[ticker].subSectors.add(s));
      tickerMentions[ticker].keywords += keywordCount;

      tickerArticles[ticker].push({
        sentiment_score: sentimentResult.score,
        pub_date: article.pubDate
      });
    }
  }

  const newsTickers = Object.keys(tickerMentions);
  console.log(`[DeepMoney] Stage 1: Discovered ${newsTickers.length} tickers from news: ${newsTickers.join(', ')}`);

  // -------------------------------------------------------------------------
  // Stage 2: Dynamic Screener Discovery
  // -------------------------------------------------------------------------
  const [growthTech, undervalued] = await Promise.all([
    getYahooScreener('growth_technology_stocks'),
    getYahooScreener('undervalued_growth_stocks')
  ]);

  const screenerTickers = new Set<string>();
  [...growthTech.quotes, ...undervalued.quotes].forEach(q => {
    if (
      q.symbol &&
      q.marketCap &&
      q.marketCap < SCREENER_THRESHOLDS.MARKET_CAP_CEILING &&
      q.marketCap > SCREENER_THRESHOLDS.MARKET_CAP_FLOOR
    ) {
      screenerTickers.add(q.symbol);
    }
  });

  console.log(`[DeepMoney] Stage 2: Discovered ${screenerTickers.size} tickers from screeners: ${Array.from(screenerTickers).join(', ')}`);

  // -------------------------------------------------------------------------
  // Stage 2.5: Company Feed Deep Scan (Pass 2)
  //
  // For the top-N Pass-1 tickers (by raw mention count), fetch that company's
  // own Yahoo Finance RSS feed and mine it for co-mentioned companies.
  // Discovered tickers are merged into tickerMentions with reduced sentiment
  // weight and a coMentionedWith annotation.
  // -------------------------------------------------------------------------
  const watchlistTickers = new Set(watchlist.map((w: any) => w.ticker));

  // Determine which tickers qualified in Pass 1 (index news + screener + watchlist)
  const pass1Tickers = new Set([
    ...Object.keys(tickerMentions),
    ...screenerTickers,
    ...watchlistTickers
  ]);

  // Pick the top MAX_COMPANY_FEED_FETCHES by mention count to bound API calls.
  // Tickers with 0 index mentions (screener/watchlist-only) are included last.
  const pass1Sorted = Array.from(pass1Tickers).sort((a, b) => {
    const countA = tickerMentions[a]?.count ?? 0;
    const countB = tickerMentions[b]?.count ?? 0;
    return countB - countA;
  });
  const feedFetchTargets = pass1Sorted.slice(0, MAX_COMPANY_FEED_FETCHES);

  console.log(`[DeepMoney] Stage 2.5: fetching company feeds for ${feedFetchTargets.length} tickers…`);

  // Fetch all company feeds in parallel
  const companyFeedResults = await Promise.all(
    feedFetchTargets.map(ticker => fetchCompanyFeedMentions(ticker))
  );

  // Merge discoveries back into tickerMentions
  for (const feedMap of companyFeedResults) {
    for (const [ticker, data] of Object.entries(feedMap)) {
      // Skip if the ticker was already a Pass-1 participant — we only want
      // genuinely *new* tickers surfaced by the company feeds.
      // (We still enrich them below; we just don't double-count mentions.)
      const isNew = !pass1Tickers.has(ticker);

      if (isNew) {
        // Brand-new ticker discovered via a company feed
        tickerMentions[ticker] = {
          count: data.count,
          sentiment: data.sentiment,
          subSectors: new Set(data.subSectors),
          keywords: data.keywords,
          coMentionedWith: new Set(data.coMentionedWith),
          fromCompanyFeed: true
        };
      } else if (tickerMentions[ticker]) {
        // Already known — augment with additional co-mention context only,
        // no double-counting of raw mention scores.
        data.coMentionedWith.forEach(src => tickerMentions[ticker].coMentionedWith.add(src));
        data.subSectors.forEach(s => tickerMentions[ticker].subSectors.add(s));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3: Enrichment & Scoring
  // -------------------------------------------------------------------------
  const allCandidateTickers = new Set([
    ...Object.keys(tickerMentions),
    ...screenerTickers,
    ...watchlistTickers
  ]);

  const enrichedResults = await Promise.all(
    Array.from(allCandidateTickers).slice(0, 40).map(ticker => {
      const m = tickerMentions[ticker] || {
        count: 0,
        sentiment: 0,
        subSectors: new Set<string>(),
        keywords: 0,
        coMentionedWith: new Set<string>(),
        fromCompanyFeed: false
      };
      const isW = watchlistTickers.has(ticker);
      const avgSentiment = m.count > 0 ? m.sentiment / m.count : 0;

      return enrichAndScore(
        ticker,
        m.count,
        avgSentiment,
        Array.from(m.subSectors),
        m.keywords,
        isW,
        Array.from(m.coMentionedWith),
        tickerArticles[ticker] || []
      ).then(r => {
        if (!r) return null;

        // Build discovery_source string
        const isScreener = screenerTickers.has(ticker);
        const isCompanyFeed = m.fromCompanyFeed;
        const hasKeywords = m.count > 0 && !isCompanyFeed;

        let source = 'keyword';
        if (isCompanyFeed && !isScreener && !isW) {
          source = 'company_feed';
        } else if (isCompanyFeed && isScreener) {
          source = 'company_feed+screener';
        } else if (isCompanyFeed && isW) {
          source = 'company_feed+watchlist';
        } else if (isScreener && hasKeywords) {
          source = 'screener+keyword';
        } else if (isScreener) {
          source = 'screener';
        }

        if (isW) {
          source = source === 'keyword' ? 'watchlist+keyword'
                 : source === 'screener' ? 'screener+watchlist'
                 : source === 'company_feed' ? 'company_feed+watchlist'
                 : source;
        }

        return { ...r, discovery_source: source };
      });
    })
  );

  const validResults = enrichedResults.filter(r => r !== null) as any[];

  // -------------------------------------------------------------------------
  // Stage 4: Compile Final Results
  // -------------------------------------------------------------------------
  const hot_stocks = [...validResults]
    .sort((a, b) => b.gps_score - a.gps_score)
    .slice(0, 5);

  const hot_ai_tech_stocks = validResults
    .filter(
      r =>
        r.classification === 'ai_tech_hyper_growth' ||
        r.sub_sectors.length > 0
    )
    .sort((a, b) => b.gps_score - a.gps_score)
    .slice(0, 3);

  const hot_markets = Object.entries(industryStats)
    .map(([industry, stats]) => ({
      industry,
      average_sentiment: stats.score / stats.count,
      count: stats.count
    }))
    .sort((a, b) => b.average_sentiment - a.average_sentiment)
    .slice(0, 2);

  const hot_ai_sectors = Object.entries(aiSubSectorStats)
    .map(([sub_sector, stats]) => ({
      sub_sector,
      average_sentiment: stats.score / stats.count,
      article_count: stats.count
    }))
    .sort((a, b) => b.average_sentiment - a.average_sentiment)
    .slice(0, 2);

  // -------------------------------------------------------------------------
  // Stage 5: ETF Discovery Module (Section 9)
  // -------------------------------------------------------------------------
  const trendingSubSectors = hot_ai_sectors.map(s => s.sub_sector);
  const allTrendingTickers = Object.keys(tickerMentions); // All tickers mentioned in today's news
  const hot_etfs = await performETFDiscovery(hot_stocks, trendingSubSectors, allTrendingTickers);

  // -------------------------------------------------------------------------
  // Stage 6: Extended Dashboard Screeners
  // -------------------------------------------------------------------------
  async function fetchUndervaluedLargeCaps() {
    const result = await getYahooScreener('undervalued_large_caps');
    const candidates = (result.quotes || [])
      .filter((q: any) => q.marketCap > 10e9 && q.trailingPE > 0 && q.trailingPE < 20)
      .map((q: any) => ({
        ticker:        q.symbol,
        company_name:  q.shortName || q.longName,
        current_price: q.regularMarketPrice,
        market_cap_m:  q.marketCap / 1e6,
        trailing_pe:   q.trailingPE,
        price_to_book: q.priceToBook,
        metric_value:  null,
        metric_label:  null,
        type:          'undervalued_large_caps',
      }));

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const scoredCandidates = await Promise.all(candidates.map(async (candidate: any) => {
      const historicalUrl = `${baseUrl}/api/stock_data/${candidate.ticker}/historical/3mo`;
      const historicalRes = await fetch(historicalUrl, {
        headers: { 'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '' },
        signal: AbortSignal.timeout(10000)
      }).then(res => res.ok ? res.json() : null).catch(() => null);

      const historicalData = (historicalRes?.historicalData?.[candidate.ticker] || []) as any[];
      const technicalResult = historicalData.length >= 51
        ? calculateTechnicalIndicators(historicalData, [], undefined, undefined, undefined)
        : null;

      const tradingSignalScore = technicalResult?.scoreBreakdown.totalScore ?? 0;
      
      return {
        ...candidate,
        tradingSignalScore,
      };
    }));

    return scoredCandidates
      .filter((c: any) => c.tradingSignalScore > 0)
      .sort((a: any, b: any) => a.trailing_pe - b.trailing_pe)
      .slice(0, 8);
  }

  async function fetchBreakoutCandidates() {
    const result = await getYahooScreener('day_gainers');
    const candidates = (result.quotes || [])
      .filter((q: any) => q.regularMarketPrice > 0 && q.fiftyTwoWeekHigh > 0)
      .map((q: any) => ({
        ticker:        q.symbol,
        company_name:  q.shortName || q.longName,
        current_price: q.regularMarketPrice,
        market_cap_m:  (q.marketCap || 0) / 1e6,
        trailing_pe:   null,
        price_to_book: null,
        metric_value:  q.fiftyTwoWeekHigh ? parseFloat(((q.regularMarketPrice / q.fiftyTwoWeekHigh) * 100).toFixed(2)) : null,
        metric_label:  '% of 52W High',
        type:          'breakout_candidates',
      }))
      .filter((s: any) => s.metric_value !== null);

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const scoredCandidates = await Promise.all(candidates.map(async (candidate: any) => {
      const historicalUrl = `${baseUrl}/api/stock_data/${candidate.ticker}/historical/3mo`;
      const historicalRes = await fetch(historicalUrl, {
        headers: { 'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '' },
        signal: AbortSignal.timeout(10000)
      }).then(res => res.ok ? res.json() : null).catch(() => null);

      const historicalData = (historicalRes?.historicalData?.[candidate.ticker] || []) as any[];
      const technicalResult = historicalData.length >= 51
        ? calculateTechnicalIndicators(historicalData, [], undefined, undefined, undefined)
        : null;

      const tradingSignalScore = technicalResult?.scoreBreakdown.totalScore ?? 0;
      
      return {
        ...candidate,
        tradingSignalScore,
      };
    }));

    return scoredCandidates
      .filter((c: any) => c.tradingSignalScore > 0)
      .sort((a: any, b: any) => (b.metric_value || 0) - (a.metric_value || 0))
      .slice(0, 8);
  }

  async function fetchInsiderActivity() {
    // Try most_bought_by_hedge_funds first, fallback to undervalued_growth_stocks
    let result = await getYahooScreener('most_bought_by_hedge_funds');

    if (!result.quotes || result.quotes.length === 0) {
      result = await getYahooScreener('undervalued_growth_stocks');
    }

    const candidates = (result.quotes || [])
      .filter((q: any) => q.symbol && q.regularMarketPrice && q.regularMarketPrice > 0)
      .map((q: any) => ({
        ticker:        q.symbol,
        company_name:  q.shortName || q.longName,
        current_price: q.regularMarketPrice,
        market_cap_m:  (q.marketCap || 0) / 1e6,
        trailing_pe:   null,
        price_to_book: null,
        metric_value:  q.regularMarketChangePercent
          ? parseFloat((q.regularMarketChangePercent * 100).toFixed(2))
          : null,
        metric_label:  'Day Change %',
        type:          'insider_activity',
      }));

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const scoredCandidates = await Promise.all(candidates.map(async (candidate: any) => {
      const historicalUrl = `${baseUrl}/api/stock_data/${candidate.ticker}/historical/3mo`;
      const historicalRes = await fetch(historicalUrl, {
        headers: { 'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '' },
        signal: AbortSignal.timeout(10000)
      }).then(res => res.ok ? res.json() : null).catch(() => null);

      const historicalData = (historicalRes?.historicalData?.[candidate.ticker] || []) as any[];
      const technicalResult = historicalData.length >= 51
        ? calculateTechnicalIndicators(historicalData, [], undefined, undefined, undefined)
        : null;

      const tradingSignalScore = technicalResult?.scoreBreakdown.totalScore ?? 0;
      
      return {
        ...candidate,
        tradingSignalScore,
      };
    }));

    return scoredCandidates
      .filter((c: any) => c.tradingSignalScore > 0)
      .slice(0, 8);
  }

  async function fetchAnalystFavorites() {
    // Try most_watched_tickers first, fallback to growth_technology_stocks
    let result = await getYahooScreener('most_watched_tickers');

    if (!result.quotes || result.quotes.length === 0) {
      result = await getYahooScreener('growth_technology_stocks');
    }

    const candidates = (result.quotes || [])
      .filter((q: any) => q.symbol && q.regularMarketPrice && q.regularMarketPrice > 0)
      .map((q: any) => {
        let metricValue = null;
        let metricLabel = 'Analyst Rating';

        // Try to calculate analyst upside if we have the data
        if (q.targetMeanPrice && q.regularMarketPrice) {
          metricValue = parseFloat(((q.targetMeanPrice - q.regularMarketPrice) / q.regularMarketPrice * 100).toFixed(2));
          metricLabel = 'Analyst Upside %';
        } else if (q.averageAnalystRating) {
          // Fallback: use analyst rating if available
          metricValue = parseFloat(String(q.averageAnalystRating));
          metricLabel = 'Avg Rating';
        } else if (q.regularMarketChangePercent) {
          // Final fallback: use price change percent
          metricValue = parseFloat((q.regularMarketChangePercent * 100).toFixed(2));
          metricLabel = 'Day Change %';
        }

        return {
          ticker:        q.symbol,
          company_name:  q.shortName || q.longName,
          current_price: q.regularMarketPrice,
          market_cap_m:  (q.marketCap || 0) / 1e6,
          trailing_pe:   null,
          price_to_book: null,
          metric_value:  metricValue,
          metric_label:  metricLabel,
          type:          'analyst_favorites',
        };
      });

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3001';
    const scoredCandidates = await Promise.all(candidates.map(async (candidate: any) => {
      const historicalUrl = `${baseUrl}/api/stock_data/${candidate.ticker}/historical/3mo`;
      const historicalRes = await fetch(historicalUrl, {
        headers: { 'x-api-key': process.env.DEEPMONEY_INTERNAL_SECRET || '' },
        signal: AbortSignal.timeout(10000)
      }).then(res => res.ok ? res.json() : null).catch(() => null);

      const historicalData = (historicalRes?.historicalData?.[candidate.ticker] || []) as any[];
      const technicalResult = historicalData.length >= 51
        ? calculateTechnicalIndicators(historicalData, [], undefined, undefined, undefined)
        : null;

      const tradingSignalScore = technicalResult?.scoreBreakdown.totalScore ?? 0;
      
      return {
        ...candidate,
        tradingSignalScore,
      };
    }));

    return scoredCandidates
      .filter((c: any) => c.tradingSignalScore > 0)
      .slice(0, 8);
  }

  const [undervalued_large_caps, breakout_candidates, insider_activity, analyst_favorites] =
    await Promise.all([
      fetchUndervaluedLargeCaps().catch(() => []),
      fetchBreakoutCandidates().catch(() => []),
      fetchInsiderActivity().catch(() => []),
      fetchAnalystFavorites().catch(() => []),
    ]);

  // -------------------------------------------------------------------------
  // Stage 7: Deep Enrichment (Post-Selection)
  // -------------------------------------------------------------------------
  // Fetch complete LSTM-ready data payloads + ticker news for finalists
  const finalists = [...hot_stocks, ...hot_ai_tech_stocks];
  const uniqueFinalistTickers = Array.from(new Set(finalists.map(s => s.ticker)));

  console.log(`[DeepMoney] Stage 6: Deep enrichment for ${uniqueFinalistTickers.length} finalists…`);
  
  const enrichmentMap: { [ticker: string]: { data: any, news: any[], earnings: any } } = {};

  const enrichmentResults = await Promise.all(
    uniqueFinalistTickers.map(async (ticker) => {
      const [data, apiNews, earnings] = await Promise.all([
        fetchCompleteStockData(ticker),
        fetchTickerNews(ticker),
        fetchTickerEarnings(ticker)
      ]);

      // Stage 1 News Integration: combine index-level mentions with ticker-specific feed
      // (This avoids re-fetching what we already found in getNews() for this ticker)
      const stage1News = articles.filter(a => {
        const text = (a.title + ' ' + (a.content || a.description || '')).toLowerCase();
        const res = a.explicitTickers 
          ? a.explicitTickers.includes(ticker)
          : nlp(text).organizations().out('array').map(resolveTicker).includes(ticker);
        return res;
      }).map(a => ({
        title: a.title,
        link: a.link,
        pubDate: a.pubDate,
        publishedAt: a.pubDate,
        source: a.source || 'Index Feed',
        sentiment_score: sentiment.analyze(a.title + ' ' + (a.content || a.description || '')).score
      }));

      // Deduplicate news by title
      const seenTitles = new Set(stage1News.map(n => n.title));
      const filteredApiNews = apiNews.filter((n: any) => !seenTitles.has(n.title));
      const combinedNews = [...stage1News, ...filteredApiNews].slice(0, 15);

      return { ticker, data, news: combinedNews, earnings };
    })
  );

  enrichmentResults.forEach(res => {
    enrichmentMap[res.ticker] = { data: res.data, news: res.news, earnings: res.earnings };
  });

  // Attach to final objects — these are the deep payloads for the Python LSTM
  const finalizeStock = (s: any) => {
    const enrichment = enrichmentMap[s.ticker];
    const data = enrichment?.data;
    const news = enrichment?.news || [];
    const earnings = enrichment?.earnings;

    return {
      ...s,
      // Flattened fields for UI (keep existing for backward compatibility if needed, 
      // but prompt implies moving them to prediction_input for the Python script)
      // The prompt asks for a specific shape. I will keep the UI fields at the root 
      // and add the prediction_input object.

      prediction_input: {
        historicalData:     data?.historicalData || [],
        stockMetrics:       data?.stockMetrics || {},
        macroData:          data?.macroData || {},
        newsArticles:       news,
        historicalEarnings: earnings?.historicalEarnings || [],
        technicalScore:     s.trading_signal_score,
        dataQuality:        data?.dataQuality || { historyYears: 0, imputedFields: [] },
      }
    };
  };

  const final_hot_stocks = hot_stocks.map(finalizeStock);
  const final_hot_ai_tech_stocks = hot_ai_tech_stocks.map(finalizeStock);

  return {
    hot_stocks: final_hot_stocks,
    hot_ai_tech_stocks: final_hot_ai_tech_stocks,
    hot_markets,
    hot_ai_sectors,
    hot_etfs,
    undervalued_large_caps,
    breakout_candidates,
    insider_activity,
    analyst_favorites,
  };
}