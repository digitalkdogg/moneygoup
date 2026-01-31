
import { NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';

const feeds = [
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EDJI',
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC',
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EIXIC'
];

export async function GET() {
  const parser = new XMLParser();
  let allItems: any[] = [];
  const errors: string[] = [];

  for (const feedUrl of feeds) {
    try {
      const response = await fetch(feedUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${feedUrl}: ${response.statusText}`);
      }
      const xml = await response.text();
      const feed = parser.parse(xml);
      if (feed.rss && feed.rss.channel && feed.rss.channel.item) {
        allItems = allItems.concat(feed.rss.channel.item);
      }
    } catch (error) {
      if (error instanceof Error) {
        errors.push(`Failed to process feed ${feedUrl}: ${error.message}`);
      } else {
        errors.push(`Failed to process feed ${feedUrl}: Unknown error`);
      }
    }
  }

  if (allItems.length === 0 && errors.length > 0) {
    return NextResponse.json({ message: 'All feeds failed to load.', errors: errors });
  }

  allItems.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  return NextResponse.json({
    items: allItems,
    errors: errors.length > 0 ? errors : undefined,
  });
}
