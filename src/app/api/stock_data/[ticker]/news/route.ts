import { NextRequest, NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';
import Sentiment from 'sentiment';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import YahooFinance from 'yahoo-finance2'; // Import YahooFinance
import { getServerSession } from 'next-auth'; // Add this import
import { authOptions } from '@/lib/auth'; // Add this import
import { tickerSchema } from '@/utils/validationSchemas';
import { validationErrorResponse } from '@/utils/errorResponse';
import { newsLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';

const logger = createLogger('api/stock/[ticker]/news');
const yahooFinance = new YahooFinance(); // Initialize YahooFinance

// NOTE: This endpoint requires authentication.
export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  // Check rate limit (per-IP)
  const rateLimitResponse = checkRateLimit(request, newsLimiter, 'news');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  // Validate and normalize ticker input
  try {
    var validatedTicker = tickerSchema.parse(params.ticker);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues && error.issues.length > 0 
        ? error.issues[0].message 
        : 'Invalid ticker';
      return validationErrorResponse(message);
    }
    return validationErrorResponse('Invalid ticker format');
  }

  const tickerArray = validatedTicker.split(',').map(t => t.trim());

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
        // 1. Get company longName for filtering
        let companyName: string | undefined;
        try {
          const quoteSummary = await yahooFinance.quoteSummary(ticker, { modules: ["price"] });
          companyName = quoteSummary.price?.longName || undefined;
        } catch (e) {
          logger.warn(`Could not fetch longName for ${ticker} from Yahoo Finance. Will filter by ticker only.`, e as Error);
        }

        const relevantKeywords: string[] = [ticker.toLowerCase()];
        if (companyName) {
            // Add full name and common variations
            relevantKeywords.push(companyName.toLowerCase());
            // Remove common corporate suffixes for broader matching
            relevantKeywords.push(
                companyName.toLowerCase()
                    .replace(/,?\s+(inc|corporation|corp|ltd|llc|co)\.?$/g, '')
                    .trim()
            );
        }

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

        // Process and filter articles for this ticker
        items.slice(0, 10).forEach((item: any) => { // Increased to 10 to allow for filtering
          const title = item.title ? item.title.toLowerCase() : '';
          const description = item.description ? item.description.toLowerCase() : '';

          // Filter: check if title or description contains relevant keywords
          const isRelevant = relevantKeywords.some(keyword => 
              title.includes(keyword) || description.includes(keyword)
          );

          if (!isRelevant) {
              return; // Skip this article if not relevant
          }

          const sentimentResult = sentiment.analyze(item.title);

          // Sanitize link: Ensure it's a safe HTTP/HTTPS URL
          let sanitizedLink = item.link;
          if (sanitizedLink) {
            if (!sanitizedLink.startsWith('http://') && !sanitizedLink.startsWith('https://')) {
              sanitizedLink = '#';
            } else if (sanitizedLink.toLowerCase().startsWith('javascript:')) {
              sanitizedLink = '#';
            }
          } else {
            sanitizedLink = '#';
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
    logger.error('Error fetching news:', { error: error instanceof Error ? error : String(error) });
    return NextResponse.json(
      {
        error: 'Failed to fetch or parse news feed'
      },
      { status: 500 }
    );
  }
}
