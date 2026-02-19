// src/app/components/WatchlistCard.tsx
'use client';

interface WatchlistItem {
  stock_id: number;
  symbol: string;
  company_name: string;
  shares: number;
  purchase_price: number;
  is_purchased: number;
}

interface WatchlistCardProps {
  stock: WatchlistItem;
  onPurchase: () => void;
  onRemove: () => void;
}

export default function WatchlistCard({ stock, onPurchase, onRemove }: WatchlistCardProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 shadow hover:shadow-lg transition-shadow">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-800">{stock.symbol}</h3>
          <p className="text-sm text-gray-600">{stock.company_name}</p>
        </div>
      </div>

      <div className="mb-4 space-y-2">
        <p className="text-xs text-gray-500">Added to watchlist</p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onPurchase}
          className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold text-sm"
        >
          Add to Portfolio
        </button>
        <button
          onClick={onRemove}
          className="flex-1 px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold text-sm"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
