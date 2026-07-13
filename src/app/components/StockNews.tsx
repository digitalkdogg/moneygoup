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
                  <span
                    style={article.sentiment_score > 0 ? { backgroundColor: '#a8d78d', color: '#166534' } : {}}
                    className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                      article.sentiment_score > 0
                        ? ''
                        : article.sentiment_score < 0
                          ? 'bg-red-100 text-red-800'
                          : 'bg-gray-300 text-gray-800'
                    }`}
                  >
                    {article.sentiment_score > 0
                      ? '📈 ' + article.sentiment_score.toFixed(1)
                      : article.sentiment_score < 0
                        ? '📉 ' + article.sentiment_score.toFixed(1)
                        : '➡️ ' + article.sentiment_score.toFixed(1)}
                  </span>
                </div>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
