import nlp from 'compromise';
import Sentiment from 'sentiment';
import { getNews } from './getNews';
import { fetchYahooStockSummary, getYahooScreener } from '@/utils/yahooFinanceHelper';
import watchlist from '@/../../public/ai_tech_watchlist.json';
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
// Scoring & Enrichment Logic
// ---------------------------------------------------------------------------

async function enrichAndScore(
  ticker: string,
  mentions: number,
  avgSentiment: number,
  subSectors: string[],
  keywordDensity: number,
  isWatchlist: boolean = false,
  coMentionedWith: string[] = []
) {
  try {
    const summary = await fetchYahooStockSummary(ticker);
    const price = summary.price?.regularMarketPrice;

    // 1. Price Filter Hard Gate
    if (!price || price >= PRICE_FILTER_MAX) return null;

    const marketCap = summary.price?.marketCap || 0;

    // Market cap hard gates
    if (marketCap < SCREENER_THRESHOLDS.MARKET_CAP_FLOOR || marketCap > SCREENER_THRESHOLDS.MARKET_CAP_CEILING) return null;

    // Watchlist Skip Logic: market cap > $10B
    if (isWatchlist && marketCap > 10e9) {
      console.warn(`Watchlist ticker ${ticker} exceeded $10B market cap, skipping.`);
      return null;
    }

    const financialData = summary.financialData;
    const stats = summary.defaultKeyStatistics;
    const profile = summary.assetProfile;
    const income = summary.incomeStatementHistory?.incomeStatementHistory?.[0];

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
      snapshot_date: new Date().toISOString().split('T')[0]
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
  const newsResponse = await getNews();
  const newsData = await newsResponse.json();
  const articles = newsData.items || [];

  const tickerMentions: { [key: string]: TickerMention } = {};
  const industryStats: { [key: string]: { score: number; count: number } } = {};
  const aiSubSectorStats: { [key: string]: { score: number; count: number } } = {};

  for (const article of articles) {
    const text = (article.title + ' ' + (article.content || '')).toLowerCase();
    const doc = nlp(text);
    const organizations: string[] = doc.organizations().out('array');
    const sentimentResult = sentiment.analyze(text);

    // Track AI Sub-sectors
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

    // Resolve Organizations to Tickers
    for (const org of organizations) {
      const ticker = resolveTicker(org);
      if (ticker) {
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
        tickerMentions[ticker].count++;
        tickerMentions[ticker].sentiment += sentimentResult.score;
        foundSubSectors.forEach(s => tickerMentions[ticker].subSectors.add(s));
        tickerMentions[ticker].keywords += keywordCount;
      }
    }

    // Track Broad Industries
    for (const [industry, keywords] of Object.entries(BROAD_INDUSTRIES)) {
      if (keywords.some(k => text.includes(k))) {
        if (!industryStats[industry]) industryStats[industry] = { score: 0, count: 0 };
        industryStats[industry].score += sentimentResult.score;
        industryStats[industry].count++;
      }
    }
  }

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
        Array.from(m.coMentionedWith)
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
        r.sub_sectors.length > 0 ||
        r.discovery_source.includes('screener')
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

  return {
    hot_stocks,
    hot_ai_tech_stocks,
    hot_markets,
    hot_ai_sectors
  };
}