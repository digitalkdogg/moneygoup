
import { NextResponse } from 'next/server';
import nlp from 'compromise';
import Sentiment from 'sentiment';

const sentiment = new Sentiment();

// Assuming the news endpoint is hosted on the same instance
const NEWS_API_URL = `${process.env.NEXTAUTH_URL}/api/deepmoney/news`;

// Load tickers from the public file
import tickers from '@/../../public/company_tickers.json';

interface Ticker {
    ticker: string;
    name: string;
}

const tickerMap: { [key: string]: { ticker: string, name: string } } = {};
(tickers as Ticker[]).forEach(t => {
    if (t.name) {
        const normalizedName = t.name.toLowerCase()
            .replace(/,?\s+(inc|corporation|corp|ltd|llc)\.?/g, '')
            .trim();
        tickerMap[normalizedName] = { ticker: t.ticker, name: t.name };
    }
});

const industries = {
    'Gold': ['gold', 'precious metals'],
    'S&P 500': ['s&p 500', 's&p', 'sp500'],
    'Dow Jones': ['dow'],
    'Silver': ['silver'],
    'Energy': ['solar', 'energy', 'Alternative fule', 'green energy'],
    'Oil': ['oil', 'crude', 'petroleum'],
    'Tech': ['tech', 'technology', 'software', 'hardware'],
    'Real Estate': ['real estate', 'housing'],
    'Biotech': ['biotech', 'pharmaceutical'],
};

export async function GET() {
    try {
        const newsResponse = await fetch(NEWS_API_URL);
        if (!newsResponse.ok) {
            throw new Error(`Failed to fetch news: ${newsResponse.statusText}`);
        }

        const newsData = await newsResponse.json();
        const articles = newsData.items || [];

        if (articles.length === 0) {
            return NextResponse.json({ message: 'No news articles found to analyze.' });
        }

        const organizationCounts: { [key: string]: number } = {};
        const industrySentiment: { [key: string]: { score: number, count: number } } = {};

        for (const article of articles) {
            const text = article.title + ' ' + (article.content || '');
            const doc = nlp(text);
            const organizations = doc.organizations().out('array');

            for (const org of organizations) {
                const orgLower = org.toLowerCase().replace(/,$/, '');
                for (const normalizedName in tickerMap) {
                    if (normalizedName.includes(orgLower)) {
                        const ticker = tickerMap[normalizedName].ticker;
                        organizationCounts[ticker] = (organizationCounts[ticker] || 0) + 1;
                        break; 
                    }
                }
            }

            const sentimentResult = sentiment.analyze(text);
            for (const industry in industries) {
                const keywords = industries[industry as keyof typeof industries];
                if (keywords.some(keyword => text.toLowerCase().includes(keyword))) {
                    if (!industrySentiment[industry]) {
                        industrySentiment[industry] = { score: 0, count: 0 };
                    }
                    industrySentiment[industry].score += sentimentResult.score;
                    industrySentiment[industry].count++;
                }
            }
        }

        const sortedCompanies = Object.entries(organizationCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 4)
            .map(([ticker, count]) => ({ ticker, count }));

        const sortedIndustries = Object.entries(industrySentiment)
            .map(([industry, { score, count }]) => ({ industry, average_sentiment: score / count, count }))
            .sort((a, b) => b.average_sentiment - a.average_sentiment)
            .slice(0, 2);

        const response: { hot_stocks?: any[], hot_markets?: any[], message?: string } = {};

        if (sortedCompanies.length > 0) {
            response.hot_stocks = sortedCompanies;
        }

        if (sortedIndustries.length > 0) {
            response.hot_markets = sortedIndustries;
        }

        if (Object.keys(response).length === 0) {
            return NextResponse.json({ message: 'No relevant stock companies or markets found in the news.' });
        }

        return NextResponse.json(response);

    } catch (error) {
        console.error(error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
        return new NextResponse(JSON.stringify({ message: 'Failed to analyze news.', error: errorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
