// src/app/components/modals/BuyMoreModal.tsx
'use client';

import { useState, useEffect } from 'react';
import { formatNumber, formatCurrency } from '@/utils/formatters';

interface PortfolioItem {
  stock_id: number;
  symbol: string;
  company_name: string;
  shares: number;
  purchase_price: number;
}

interface BuyMoreModalProps {
  stock: PortfolioItem;
  onClose: () => void;
}

export default function BuyMoreModal({ stock, onClose }: BuyMoreModalProps) {
  const [shares, setShares] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [newAvgPrice, setNewAvgPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Calculate new average price as user types
  useEffect(() => {
    const sharesNum = parseFloat(shares);
    const priceNum = parseFloat(price);

    if (!isNaN(sharesNum) && !isNaN(priceNum) && sharesNum > 0 && priceNum > 0) {
      const currentCost = parseFloat(stock.shares as any) * parseFloat(stock.purchase_price as any);
      const newCost = sharesNum * priceNum;
      const totalShares = parseFloat(stock.shares as any) + sharesNum;
      const avgPrice = (currentCost + newCost) / totalShares;
      setNewAvgPrice(avgPrice);
    } else {
      setNewAvgPrice(null);
    }
  }, [shares, price, stock]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const sharesNum = parseFloat(shares);
    const priceNum = parseFloat(price);

    if (isNaN(sharesNum) || sharesNum <= 0) {
      setError('Shares must be a positive number');
      return;
    }

    if (isNaN(priceNum) || priceNum <= 0) {
      setError('Price must be a positive number');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`/api/user/stocks/${stock.stock_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'buy',
          shares: sharesNum,
          price: priceNum,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to buy more shares');
      }

      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md m-4">
        <h2 className="text-2xl font-bold text-gray-800 mb-6">Buy More Shares</h2>
        
        <div className="mb-6 p-4 bg-gray-50 rounded-lg space-y-2">
          <div className="flex justify-between">
            <span className="text-sm text-gray-600">Symbol:</span>
            <span className="font-semibold text-gray-800">{stock.symbol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-600">Current Shares:</span>
            <span className="font-semibold text-gray-800">{formatNumber(stock.shares, 4)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-600">Avg Cost:</span>
            <span className="font-semibold text-gray-800">{formatCurrency(stock.purchase_price)}</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Number of Shares to Buy
            </label>
            <input
              type="number"
              step="0.0001"
              min="0"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., 5"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Price per Share ($)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., 160.00"
            />
          </div>

          {newAvgPrice !== null && (
            <div className="p-4 bg-blue-50 rounded-lg space-y-2">
              <p className="text-sm text-gray-600">
                Total Cost of New Shares: <span className="font-semibold text-gray-800">
                  {formatCurrency(parseFloat(shares) * parseFloat(price))}
                </span>
              </p>
              <p className="text-sm text-gray-600">
                New Average Price: <span className="font-semibold text-blue-600">
                  {formatCurrency(newAvgPrice)}
                </span>
              </p>
              <p className="text-sm text-gray-600">
                Total Shares After: <span className="font-semibold text-gray-800">
                  {formatNumber(parseFloat(stock.shares as any) + parseFloat(shares), 4)}
                </span>
              </p>
            </div>
          )}

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <div className="flex justify-end space-x-4 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors font-semibold disabled:opacity-50"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors font-semibold disabled:opacity-50"
              disabled={loading}
            >
              {loading ? 'Buying...' : 'Confirm Buy'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
