import { NextRequest, NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';
import Sentiment from 'sentiment';

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
      return {
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        source: item.source,
        sentiment_score: sentimentResult.score, // score is a number, comparative is a number
      }
    });

    return NextResponse.json({ articles, source: ['Yahoo Finance'] });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching news:', errorMessage);
    return NextResponse.json(
      {
        error: 'Failed to fetch or parse news feed'
      },
      { status: 500 }
    );
  }
}
