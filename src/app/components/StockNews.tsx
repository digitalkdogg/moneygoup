'use client';

interface Article {
  title: string;
  link: string;
  pubDate: string;
}

interface StockNewsProps {
  articles: Article[];
}

export default function StockNews({ articles }: StockNewsProps) {
  if (!articles) {
    return (
      <div className="text-center p-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-2 text-gray-600">Loading News...</p>
      </div>
    );
  }

  if (articles.length === 0) {
    return <p className="text-center text-gray-500">No recent news found for this stock.</p>;
  }

  return (
    <div className="p-6">
        <h3 className="text-2xl font-bold text-gray-800 mb-4 text-center">📰 Latest News</h3>
        <div className="space-y-2">
            {articles.map((article, index) => (
            <a 
                key={index}
                href={article.link}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors duration-200"
            >
                <h4 className="font-semibold text-blue-600 hover:text-blue-800">{article.title}</h4>
                <p className="text-xs text-gray-500 mt-0.5">
                {new Date(article.pubDate).toLocaleString()}
                </p>
            </a>
            ))}
        </div>
    </div>
  );
}
