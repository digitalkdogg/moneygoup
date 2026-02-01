import { NextRequest, NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';
import Sentiment from 'sentiment';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/stock/[ticker]/news');

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  // Normalize input to array
  const tickerString = params.ticker.toUpperCase();
  const tickerArray = tickerString.split(',').map(t => t.trim());

  try {
    const sentiment = new Sentiment();
    const articlesByTicker: Record<string, any[]> = {};
    
    // Initialize empty arrays for all requested tickers
    tickerArray.forEach(ticker => {
      articlesByTicker[ticker] = [];
    });

    // Fetch RSS feed for each ticker individually
    const fetchPromises = tickerArray.map(async (ticker) => {
      try {
        const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
        const response = await fetch(url);

        if (!response.ok) {
          console.warn(`Failed to fetch RSS feed for ${ticker}: ${response.statusText}`);
          return;
        }

        const xmlText = await response.text();
        const parser = new XMLParser();
        const parsed = parser.parse(xmlText);

        if (!parsed.rss || !parsed.rss.channel || !parsed.rss.channel.item) {
          return;
        }

        const items = Array.isArray(parsed.rss.channel.item)
          ? parsed.rss.channel.item
          : [parsed.rss.channel.item];

        // Process articles for this ticker
        items.slice(0, 5).forEach((item: any) => {
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

          const article = {
            title: item.title,
            link: sanitizedLink,
            pubDate: item.pubDate,
            source: item.source,
            sentiment_score: sentimentResult.score,
          };

          articlesByTicker[ticker].push(article);
        });
      } catch (error) {
        console.warn(`Error fetching news for ${ticker}:`, error);
      }
    });

    await Promise.all(fetchPromises);

    return NextResponse.json({ articles: articlesByTicker, source: ['Yahoo Finance'] });
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
