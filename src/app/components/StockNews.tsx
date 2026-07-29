'use client';

interface Article {
  title: string;
  link: string;
  pubDate: string;
  source?: string;
  sentiment_score?: number;
}

interface StockNewsProps {
  articles: Article[] | Record<string, Article[]> | any;
  ticker?: string;
  titleLevel?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}

function SentimentTag({ score }: { score: number }) {
  let label: string;
  let bg: string;
  let color: string;
  let dot: string;

  if (score >= 0.3) {
    label = 'Bullish'; bg = '#dcfce7'; color = '#15803d'; dot = '#16a34a';
  } else if (score > 0.05) {
    label = 'Positive'; bg = '#f0fdf4'; color = '#166534'; dot = '#4ade80';
  } else if (score <= -0.3) {
    label = 'Bearish'; bg = '#fee2e2'; color = '#991b1b'; dot = '#dc2626';
  } else if (score < -0.05) {
    label = 'Negative'; bg = '#fef2f2'; color = '#b91c1c'; dot = '#f87171';
  } else {
    label = 'Neutral'; bg = '#f3f4f6'; color = '#4b5563'; dot = '#9ca3af';
  }

  return (
    <span
      style={{ backgroundColor: bg, color }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: dot, display: 'inline-block', flexShrink: 0 }} />
      {label}
      <span style={{ opacity: 0.65, fontWeight: 400 }}>
        {score > 0 ? '+' : ''}{score.toFixed(2)}
      </span>
    </span>
  );
}

export default function StockNews({ articles, ticker, titleLevel = 'h2' }: StockNewsProps) {
  // Handle different article formats
  let articleList: Article[] = [];
  const TitleTag = titleLevel;

  if (Array.isArray(articles)) {
    // Format 1: Direct array of articles
    articleList = articles;
  } else if (typeof articles === 'object' && articles !== null) {
    // Format 2: Object with ticker keys
    if (ticker && articles[ticker]) {
      // Get articles for specific ticker
      articleList = articles[ticker];
    } else {
      // Get first available ticker's articles
      const firstKey = Object.keys(articles)[0];
      if (firstKey) {
        articleList = articles[firstKey] || [];
      }
    }
  }

  if (!articleList || articleList.length === 0) {
    return (
      <div className="text-center p-4">
        <p className="text-gray-500">No recent news found for this stock.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <TitleTag className="text-2xl font-bold text-gray-800 mb-4 text-left">📰 Latest News</TitleTag>
      <div className="space-y-2">
        {articleList.map((article, index) => (
          <a
            key={index}
            href={article.link}
            target="_blank"
            rel="noopener noreferrer"
            className="block p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors duration-200"
          >
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1">
                <h3 className="font-semibold text-blue-600 hover:text-blue-800 !text-[16px]">
                  {article.title}
                </h3>
                <p className="!text-[14px] text-gray-500 mt-0.5">
                  {new Date(article.pubDate).toLocaleString()}
                </p>
                {article.source && (
                  <p className="text-xs text-gray-400 mt-1">
                    Source: {article.source}
                  </p>
                )}
              </div>
              {article.sentiment_score !== undefined && (
                <div className="flex-shrink-0 pt-1">
                  <SentimentTag score={article.sentiment_score} />
                </div>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
