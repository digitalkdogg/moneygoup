// src/app/components/PortfolioCard.tsx
import { formatNumber, formatCurrency } from '@/utils/formatters'
import type { PortfolioItem } from '@/types/portfolio'; // Added this import

interface PortfolioCardProps {
  stock: PortfolioItem;
  onBuyMore: () => void;
  onSell: () => void;
}

export default function PortfolioCard({ stock, onBuyMore, onSell }: PortfolioCardProps) {
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    try {
      return new Date(dateStr).toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        year: '2-digit' 
      });
    } catch {
      return 'N/A';
    }
  };

  const positionValue = stock.regularMarketPrice !== null 
    ? stock.shares * stock.regularMarketPrice
    : parseFloat(stock.shares as any) * parseFloat(stock.purchase_price as any); // Fallback

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 shadow hover:shadow-lg transition-shadow">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-800">{stock.symbol}</h3>
          <p className="text-sm text-gray-600">{stock.company_name}</p>
        </div>
      </div>

      <div className="mb-4 space-y-2 bg-gray-50 p-3 rounded">
        <div className="flex justify-between">
          <span className="text-xs text-gray-600">Shares:</span>
          <span className="text-sm font-semibold text-gray-800">{formatNumber(stock.shares, 4)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-gray-600">Avg Price:</span>
          <span className="text-sm font-semibold text-gray-800">{formatCurrency(stock.purchase_price)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-gray-600">Current Price:</span>
          <span className="text-sm font-semibold text-blue-600">
            {stock.regularMarketPrice !== null ? formatCurrency(stock.regularMarketPrice) : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-gray-600">Position Value:</span>
          <span className="text-sm font-semibold text-green-600">
            {formatCurrency(positionValue)}
          </span>
        </div>
        <div className="flex justify-between text-xs text-gray-500 pt-2 border-t border-gray-200">
          <span>Purchased: {formatDate(stock.initial_purchase_date)}</span>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onBuyMore}
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold text-sm"
        >
          Buy More
        </button>
        <button
          onClick={onSell}
          className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-semibold text-sm"
        >
          Sell
        </button>
      </div>
    </div>
  );
}
