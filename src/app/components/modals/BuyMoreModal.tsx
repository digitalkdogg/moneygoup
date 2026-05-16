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
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <h2 id="modal-title" className="text-2xl font-bold text-gray-800 mb-6">Buy More Shares</h2>
        
        <div className="mb-6 p-4 bg-gray-50 rounded-lg space-y-2" aria-label="Stock Information">
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
            <label htmlFor="buy-shares" className="block text-sm font-medium text-gray-700 mb-2">
              Number of Shares to Buy
            </label>
            <input
              id="buy-shares"
              type="number"
              step="0.0001"
              min="0"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus-ring"
              placeholder="e.g., 5"
              required
            />
          </div>

          <div>
            <label htmlFor="buy-price" className="block text-sm font-medium text-gray-700 mb-2">
              Price per Share ($)
            </label>
            <input
              id="buy-price"
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus-ring"
              placeholder="e.g., 160.00"
              required
            />
          </div>

          {newAvgPrice !== null && (
            <div className="p-4 bg-green-50 rounded-lg space-y-2" aria-live="polite">
              <p className="text-sm text-gray-600">
                Total Cost of New Shares: <span className="font-semibold text-gray-800">
                  {formatCurrency(parseFloat(shares) * parseFloat(price))}
                </span>
              </p>
              <p className="text-sm text-gray-500">
                New Average Price: <span className="font-semibold" style={{ color: "var(--brand-green-accent)" }}>
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

          <div aria-live="assertive">
            {error && <p className="text-red-600 text-sm font-medium">{error}</p>}
          </div>

          <div className="flex justify-end space-x-4 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors disabled:opacity-50 focus-ring"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 text-white rounded-lg hover:bg-green-800 transition-colors disabled:opacity-50 focus-ring"
              style={{ backgroundColor: "var(--brand-green-700)" }}
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
