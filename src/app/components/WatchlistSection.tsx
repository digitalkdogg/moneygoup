// src/app/components/WatchlistSection.tsx
'use client';

import { useState, useEffect } from 'react';
import PurchaseFromWatchlistModal from './modals/PurchaseFromWatchlistModal';
import { useRouter } from 'next/navigation';

interface WatchlistItem {
  stock_id: number;
  symbol: string;
  company_name: string;
  shares: number;
  purchase_price: number;
  is_purchased: number;
  current_price: number | null; // Added current_price
  ma6_month: number | null; // Added 6-month moving average


}

interface WatchlistSectionProps {
  onRefresh?: () => void;
}

export default function WatchlistSection({ onRefresh }: WatchlistSectionProps) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<WatchlistItem | null>(null);
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const router = useRouter();

  const handleRowClick = (symbol: string) => {
    router.push(`/search/${symbol}`);
  };

  const handleActionClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row click from firing when action buttons are clicked
  };

  useEffect(() => {
    fetchWatchlist();
  }, []);

  const fetchWatchlist = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/user/watchlist');
      
      if (!response.ok) {
        throw new Error('Failed to fetch watchlist');
      }
      
      const data = await response.json();
      setWatchlist(data.watchlist.map((item: any) => ({
        ...item,
        current_price: item.current_price !== null ? parseFloat(item.current_price) : null
      })) || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePurchase = (stock: WatchlistItem) => {
    setSelectedStock(stock);
    setShowPurchaseModal(true);
  };

  const handleRemove = async (stock: WatchlistItem) => {
    if (!confirm(`Remove ${stock.symbol} from watchlist?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/user/watchlist?stockId=${stock.symbol}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to remove from watchlist');
      }

      setWatchlist(watchlist.filter(s => s.stock_id !== stock.stock_id));
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleModalClose = () => {
    setSelectedStock(null);
    setShowPurchaseModal(false);
    fetchWatchlist();
    onRefresh?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-600">
        {error}
      </div>
    );
  }

  if (watchlist.length === 0) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center text-gray-500">
        <p>Your watchlist is empty. Search for stocks to add them!</p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white p-8 rounded-2xl shadow-lg mb-8">
        <h2 className="text-2xl font-bold text-gray-800 mb-6">👀 My Watchlist</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Company Name</th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">6M MA</th>
                <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {watchlist.map((stock) => (
                <tr 
                  key={stock.stock_id} 
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => handleRowClick(stock.symbol)}
                >
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{stock.symbol}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{stock.company_name}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-blue-600 font-semibold">
                    {stock.current_price !== null ? `$${stock.current_price.toFixed(2)}` : 'N/A'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                    {stock.ma6_month !== null ? `$${stock.ma6_month.toFixed(2)}` : 'N/A'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-center space-x-2" onClick={handleActionClick}>
                    <button
                      onClick={() => handlePurchase(stock)}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold text-sm"
                    >
                      Add to Portfolio
                    </button>
                    <button
                      onClick={() => handleRemove(stock)}
                      className="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold text-sm"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showPurchaseModal && selectedStock && (
        <PurchaseFromWatchlistModal stock={selectedStock} onClose={handleModalClose} />
      )}
    </>
  );
}
