import { NextRequest, NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';
import Sentiment from 'sentiment';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import YahooFinance from 'yahoo-finance2';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { tickerSchema } from '@/utils/validationSchemas';
import { validationErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { newsLimiter } from '@/utils/rateLimiter';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { z } from 'zod';
import { newsDataCache } from '@/utils/cache';

const logger = createLogger('api/stock/[ticker]/news');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = apiKey && apiKey === internalSecret;

  if (!isInternal) {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) return originCheckResponse;

    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    const approvalOutcome = await checkApprovalGuard((session as any).user?.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }
  }

  const rateLimitResponse = checkRateLimit(request, newsLimiter, 'news');
  if (rateLimitResponse) return rateLimitResponse;

  let validatedTicker: string;
  try {
    validatedTicker = tickerSchema.parse(params.ticker);
  } catch (error) {
    return validationErrorResponse('Invalid ticker format');
  }

  const tickerArray = validatedTicker.split(',').map(t => t.trim());
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  try {
    const sentiment = new Sentiment();
    // Custom financial sentiment overrides
    const financialLexicon = {
      'beat': 3,
      'beats': 3,
      'surge': 3,
      'growth': 2,
      'backlog': 1,
      'demand': 1, // "demand" is often positive in financial news
      'bullish': 3,
      'bearish': -3,
      'upgrade': 3,
      'downgrade': -3,
      'high-growth': 3,
      'acceleration': 2,
      'aligning': 1,
      'drops': -2,
      'tumbles': -3,
      'soars': 3,
      'rally': 3,
      'plunges': -3,
      'lower': -1,
      'higher': 1,
      'outperform': 3,
      'underperform': -3,
      'buy': 2,
      'sell': -2,
      'hold': 0,
      'profit': 2,
      'loss': -2,
      'miss': -3,
      'misses': -3,
      'beat expectations': 4,
      'missed expectations': -4,
      'q1': 0, 'q2': 0, 'q3': 0, 'q4': 0,
    };

    const articlesByTicker: Record<string, any[]> = {};
    const tickersToFetch: string[] = [];
    let allFromCache = true;
    
    for (const ticker of tickerArray) {
      if (!forceRefresh) {
        const cached = newsDataCache.get(ticker);
        if (cached) {
          articlesByTicker[ticker] = cached;
          continue;
        }
      }
      allFromCache = false;
      tickersToFetch.push(ticker);
      articlesByTicker[ticker] = [];
    }

    if (tickersToFetch.length > 0) {
      const fetchPromises = tickersToFetch.map(async (ticker) => {
        try {
          let companyName: string | undefined;
          try {
            const quoteSummary = await yahooFinance.quoteSummary(ticker, { modules: ["price"] });
            companyName = quoteSummary.price?.longName || undefined;
          } catch (e) {
            logger.warn(`Could not fetch longName for ${ticker}`);
          }

          const relevantKeywords: string[] = [ticker.toLowerCase()];
          if (companyName) {
              relevantKeywords.push(companyName.toLowerCase());
              relevantKeywords.push(companyName.toLowerCase().replace(/,?\s+(inc|corporation|corp|ltd|llc|co)\.?$/g, '').trim());
          }

          const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
          const response = await fetch(url);
          if (!response.ok) return;

          const xmlText = await response.text();
          const parser = new XMLParser();
          const parsed = parser.parse(xmlText);
          if (!parsed.rss || !parsed.rss.channel || !parsed.rss.channel.item) return;

          const items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
          const tickerArticles: any[] = [];
          items.slice(0, 10).forEach((item: any) => {
            const title = item.title ? item.title.toLowerCase() : '';
            const description = item.description ? item.description.toLowerCase() : '';
            const isRelevant = relevantKeywords.some(keyword => title.includes(keyword) || description.includes(keyword));
            if (!isRelevant) return;

            // Analyze both title and description for better coverage
            const combinedText = `${item.title}. ${item.description || ''}`;
            const sentimentResult = sentiment.analyze(combinedText, {
              extras: financialLexicon
            });

            let sanitizedLink = item.link;
            if (sanitizedLink && !sanitizedLink.startsWith('http')) sanitizedLink = '#';

            tickerArticles.push({
              title: item.title, 
              link: sanitizedLink || '#', 
              pubDate: item.pubDate, 
              publishedAt: item.pubDate, 
              source: item.source, 
              sentiment_score: sentimentResult.comparative,
            });
          });

          articlesByTicker[ticker] = tickerArticles;
          newsDataCache.set(ticker, tickerArticles);
        } catch (error) {
          console.warn(`Error fetching news for ${ticker}:`, error);
        }
      });
      await Promise.all(fetchPromises);
    }

    const source = allFromCache ? 'cache' : 'livedata';
    return NextResponse.json({ articles: articlesByTicker, source: ['Yahoo Finance'], cache_status: source });
  } catch (error) {
    logger.error('Error fetching news:', { error: error instanceof Error ? error : String(error) });
    return NextResponse.json({ error: 'Failed to fetch or parse news feed' }, { status: 500 });
  }
}
