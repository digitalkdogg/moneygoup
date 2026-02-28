
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
  resolveTicker
} from './config';

const sentiment = new Sentiment();

// ---------------------------------------------------------------------------
// Scoring & Enrichment Logic
// ---------------------------------------------------------------------------

async function enrichAndScore(ticker: string, mentions: number, avgSentiment: number, subSectors: string[], keywordDensity: number, isWatchlist: boolean = false) {
  try {
    const summary = await fetchYahooStockSummary(ticker);
    const price = summary.price?.regularMarketPrice;

    // 1. Price Filter Hard Gate
    if (!price || price >= PRICE_FILTER_MAX) return null;

    const marketCap = summary.price?.marketCap || 0;

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
    const epsGrowth = stats?.forwardEps && stats?.trailingEps ? (stats.forwardEps - stats.trailingEps) / Math.abs(stats.trailingEps || 1) : 0;
    const fiftyTwoWeekChange = (stats?.fiftyTwoWeekChange as number) || 0;
    const analystUpside = financialData?.targetMeanPrice ? (financialData.targetMeanPrice - price) / price : 0;
    const grossMargin = financialData?.grossMargins || 0;
    const rdSpend = income?.researchDevelopment || 0;
    const revenue = financialData?.totalRevenue || 1;
    const rdSpendPct = rdSpend / revenue;

    // 2. Growth Classification
    let classification = 'standard';
    const isTech = profile?.sector === 'Technology' || profile?.sector === 'Communication Services';
    
    // Profile C: AI/Tech Hyper-Growth
    if (isTech && revenueGrowth >= 0.20 && grossMargin >= 0.50 && rdSpendPct >= 0.10) {
      classification = 'ai_tech_hyper_growth';
    } else if (revenueGrowth >= 0.10 && epsGrowth > 0 && fiftyTwoWeekChange >= 0.10) {
      classification = 'established_growth';
    } else if (revenueGrowth >= 0.15 && marketCap >= 300e6 && marketCap <= 10e9 && analystUpside >= 0.15) {
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
    
    // Final Score
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
      discovery_source: 'keyword',
      snapshot_date: new Date().toISOString().split('T')[0]
    };
  } catch (e) {
    console.error(`Error enriching ${ticker}:`, e);
    return null;
  }
}

export async function performDeepAnalysis() {
  // Stage 1: News Analysis
  const newsResponse = await getNews();
  const newsData = await newsResponse.json();
  const articles = newsData.items || [];

  const tickerMentions: { [key: string]: { count: number, sentiment: number, subSectors: Set<string>, keywords: number } } = {};
  const industryStats: { [key: string]: { score: number, count: number } } = {};
  const aiSubSectorStats: { [key: string]: { score: number, count: number } } = {};

  for (const article of articles) {
    const text = (article.title + ' ' + (article.content || '')).toLowerCase();
    const doc = nlp(text);
    const organizations = doc.organizations().out('array');
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
          tickerMentions[ticker] = { count: 0, sentiment: 0, subSectors: new Set(), keywords: 0 };
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

  // Stage 2: Dynamic Screener Discovery
  const [growthTech, undervalued] = await Promise.all([
      getYahooScreener('growth_technology_stocks'),
      getYahooScreener('undervalued_growth_stocks')
  ]);

  const screenerTickers = new Set<string>();
  [...growthTech.quotes, ...undervalued.quotes].forEach(q => {
      if (q.symbol && q.marketCap && q.marketCap < SCREENER_THRESHOLDS.MARKET_CAP_CEILING && q.marketCap > SCREENER_THRESHOLDS.MARKET_CAP_FLOOR) {
          screenerTickers.add(q.symbol);
      }
  });

  // Stage 3: Enrichment & Scoring
  const watchlistTickers = new Set(watchlist.map(w => w.ticker));
  const allCandidateTickers = new Set([
    ...Object.keys(tickerMentions), 
    ...screenerTickers, 
    ...watchlistTickers
  ]);
  
  const enrichedResults = await Promise.all(
    Array.from(allCandidateTickers).slice(0, 40).map(ticker => {
      const m = tickerMentions[ticker] || { count: 0, sentiment: 0, subSectors: new Set<string>(), keywords: 0 };
      const isW = watchlistTickers.has(ticker);
      const res = enrichAndScore(ticker, m.count, m.count > 0 ? m.sentiment / m.count : 0, Array.from(m.subSectors), m.keywords, isW);
      
      return res.then(r => {
        if (!r) return null;
        let source = r.discovery_source;
        if (screenerTickers.has(ticker) && m.count > 0) source = 'screener+keyword';
        else if (screenerTickers.has(ticker)) source = 'screener';
        if (isW) source = source === 'keyword' ? 'watchlist+keyword' : (source === 'screener' ? 'screener+watchlist' : 'watchlist');
        
        return { ...r, discovery_source: source };
      });
    })
  );

  const validResults = enrichedResults.filter(r => r !== null) as any[];

  // Stage 4: Compile Final Results
  const hot_stocks = [...validResults]
    .sort((a, b) => b.gps_score - a.gps_score)
    .slice(0, 5);

  const hot_ai_tech_stocks = validResults
    .filter(r => r.classification === 'ai_tech_hyper_growth' || r.sub_sectors.length > 0 || r.discovery_source.includes('screener'))
    .sort((a, b) => b.gps_score - a.gps_score)
    .slice(0, 3);

  const hot_markets = Object.entries(industryStats)
    .map(([industry, stats]) => ({ industry, average_sentiment: stats.score / stats.count, count: stats.count }))
    .sort((a, b) => b.average_sentiment - a.average_sentiment)
    .slice(0, 2);

  const hot_ai_sectors = Object.entries(aiSubSectorStats)
    .map(([sub_sector, stats]) => ({ sub_sector, average_sentiment: stats.score / stats.count, article_count: stats.count }))
    .sort((a, b) => b.average_sentiment - a.average_sentiment)
    .slice(0, 2);

  return {
    hot_stocks,
    hot_ai_tech_stocks,
    hot_markets,
    hot_ai_sectors
  };
}
