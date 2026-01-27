import { NextRequest, NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';
import Sentiment from 'sentiment';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/stock/[ticker]/news');

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const ticker = params.ticker.toUpperCase();
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
  const sentiment = new Sentiment();

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch RSS feed: ${response.statusText}`);
    }

    const xmlText = await response.text();
    const parser = new XMLParser();
    const parsed = parser.parse(xmlText);

    if (!parsed.rss || !parsed.rss.channel || !parsed.rss.channel.item) {
      return NextResponse.json([]);
    }

    const items = Array.isArray(parsed.rss.channel.item) 
      ? parsed.rss.channel.item 
      : [parsed.rss.channel.item];

    const articles = items.slice(0, 5).map((item: any) => {
      const sentimentResult = sentiment.analyze(item.title);

      // Sanitize link: Ensure it's a safe HTTP/HTTPS URL
      let sanitizedLink = item.link;
      if (sanitizedLink) {
        // Check for safe protocols and block javascript:
        if (!sanitizedLink.startsWith('http://') && !sanitizedLink.startsWith('https://')) {
          sanitizedLink = '#'; // Neutralize non-http/https links
        } else if (sanitizedLink.toLowerCase().startsWith('javascript:')) {
          sanitizedLink = '#'; // Explicitly block javascript: schemes
        }
      } else {
        sanitizedLink = '#'; // Neutralize missing links
      }

      return {
        title: item.title,
        link: sanitizedLink, // Use the sanitized link
        pubDate: item.pubDate,
        source: item.source,
        sentiment_score: sentimentResult.score,
      }
    });

    return NextResponse.json({ articles, source: ['Yahoo Finance'] });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error fetching news:', error instanceof Error ? error : String(error));
    return NextResponse.json(
      {
        error: 'Failed to fetch or parse news feed'
      },
      { status: 500 }
    );
  }
}
