import { XMLParser } from 'fast-xml-parser';
import { MARKETBEAT_FEED_URL, THESTREET_FEED_URL, MOTLEYFOOL_FEED_URL } from './config';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/prediction/deepmoney/getNews');

const feeds = [
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EDJI',
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC',
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EIXIC',
  MARKETBEAT_FEED_URL,
  THESTREET_FEED_URL,
  MOTLEYFOOL_FEED_URL
];

const isMarketBeatFeed = (feedUrl: string): boolean =>
  feedUrl.includes('marketbeat.com');

const isTheStreetFeed = (feedUrl: string): boolean =>
  feedUrl.includes('thestreet.com');

const isMotleyFoolFeed = (feedUrl: string): boolean =>
  feedUrl.includes('fool.com');

const parseCategories = (item: any): string[] => {
  const raw = item.category;
  if (!raw) return [];
  const cats: any[] = Array.isArray(raw) ? raw : [raw];
  return cats
    .map((c: any) => {
      // Handle fast-xml-parser object case (if attributes present)
      const val = typeof c === 'string' ? c : (c['#text'] || c['_text'] || String(c));
      return (val.includes(':') ? val.split(':')[1] : val);
    })
    .filter((t: string) => t && t.length >= 1 && t.length <= 6); // guard against malformed values
};

export async function getNews() {
  const parser = new XMLParser({ htmlEntities: true });
  let allItems: any[] = [];
  const errors: string[] = [];
  const sourceStats = { yahoo: 0, marketbeat: 0, thestreet: 0, motleyfool: 0 };

  for (const feedUrl of feeds) {
    const startTime = Date.now();
    try {
      const response = await fetch(feedUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const xml = await response.text();
      const feed = parser.parse(xml);
      
      if (feed.rss && feed.rss.channel && feed.rss.channel.item) {
        const items = Array.isArray(feed.rss.channel.item) 
          ? feed.rss.channel.item 
          : [feed.rss.channel.item];
        
        const isMB = isMarketBeatFeed(feedUrl);
        const isTST = isTheStreetFeed(feedUrl);
        const isFool = isMotleyFoolFeed(feedUrl);
        
        const enrichedItems = items.map((item: any) => ({
          ...item,
          source: isMB ? 'marketbeat' : (isTST ? 'thestreet' : (isFool ? 'motleyfool' : 'yahoo')),
          explicitTickers: (isMB || isFool) ? parseCategories(item) : [],
        }));

        allItems = allItems.concat(enrichedItems);
        
        if (isMB) {
          sourceStats.marketbeat += enrichedItems.length;
        } else if (isTST) {
          sourceStats.thestreet += enrichedItems.length;
        } else if (isFool) {
          sourceStats.motleyfool += enrichedItems.length;
        } else {
          sourceStats.yahoo += enrichedItems.length;
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const domain = new URL(feedUrl).hostname;
      
      logger.error('Feed fetch failed', { 
        feedUrl, 
        domain,
        durationMs: duration,
        error: errorMsg 
      });
      errors.push(`Failed to process feed ${feedUrl}: ${errorMsg}`);
    }
  }

  // Deduplicate by guid, fallback to link
  const seenGuids = new Set<string>();
  const initialCount = allItems.length;
  allItems = allItems.filter(item => {
    const id = item.guid?._text ?? item.guid ?? item.link ?? '';
    if (seenGuids.has(id)) return false;
    seenGuids.add(id);
    return true;
  });

  if (allItems.length === 0 && errors.length > 0) {
    throw new Error(`All feeds failed to load: ${errors.join('; ')}`);
  }

  // Sort by pubDate descending
  allItems.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  // Log summary breakdown
  logger.info('DeepMoney news fetch summary', {
    ...sourceStats,
    total: allItems.length,
    deduped: initialCount - allItems.length,
    errorCount: errors.length
  });

  // Check for feed staleness (AC-07)
  const mbItems = allItems.filter(i => i.source === 'marketbeat');
  const tstItems = allItems.filter(i => i.source === 'thestreet');
  const foolItems = allItems.filter(i => i.source === 'motleyfool');

  [
    { name: 'MarketBeat', items: mbItems },
    { name: 'TheStreet', items: tstItems },
    { name: 'MotleyFool', items: foolItems }
  ].forEach(feed => {
    if (feed.items.length > 0) {
      const latest = new Date(feed.items[0].pubDate).getTime();
      const stalenessMs = Date.now() - latest;
      if (stalenessMs > 24 * 60 * 60 * 1000) {
        logger.warn(`${feed.name} feed staleness detected`, { 
          stalenessHours: (stalenessMs / (3600 * 1000)).toFixed(1) 
        });
      }
    }
  });

  return {
    items: allItems,
    errors: errors.length > 0 ? errors : undefined,
  };
}
