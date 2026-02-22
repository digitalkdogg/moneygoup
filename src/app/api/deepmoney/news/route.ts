// src/app/api/deepmoney/news/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/deepmoney/news');

// ---------------------------------------------------------------------------
// GET /api/deepmoney/news
//
// Returns parsed RSS news items for the requested ticker or topic.
// Protected: requires a valid session and a same-origin request.
//
// Previously this route had no authentication — it was the only unprotected
// route in the codebase. Any unauthenticated caller could use it to proxy
// requests to Yahoo Finance RSS feeds on the server's behalf.
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  // 1. Reject cross-origin requests
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  // 2. Require an active session
  const session = await getServerSession(authOptions);
  if (!session || !session.user) {
    return unauthorizedResponse('Authentication required');
  }

  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || searchParams.get('ticker') || '';

    const news = await getNews(query);
    return NextResponse.json(news);
  } catch (error) {
    logger.error('Failed to fetch news', {
      error: error instanceof Error ? error : String(error),
    });
    return NextResponse.json(
      { message: 'Failed to fetch news' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// getNews — fetches and parses Yahoo Finance RSS for a given query
// ---------------------------------------------------------------------------
async function getNews(query: string): Promise<NewsItem[]> {
  const encodedQuery = encodeURIComponent(query);
  const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodedQuery}&region=US&lang=en-US`;

  const response = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    next: { revalidate: 300 }, // Cache for 5 minutes
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance RSS returned ${response.status}`);
  }

  const xml = await response.text();
  return parseRssItems(xml);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Simple RSS XML parser — avoids a heavy dependency for a flat feed
// ---------------------------------------------------------------------------
function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];

  // Extract all <item> blocks
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const block = match[1];

    const title       = extractTag(block, 'title');
    const link        = extractTag(block, 'link');
    const pubDate     = extractTag(block, 'pubDate');
    const description = extractTag(block, 'description');
    const source      = extractTag(block, 'source') || 'Yahoo Finance';

    if (title && link) {
      items.push({ title, link, pubDate, description, source });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
  return (match?.[1] ?? match?.[2] ?? '').trim();
}