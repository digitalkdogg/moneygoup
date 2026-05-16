// src/app/components/modals/PurchaseFromWatchlistModal.tsx
'use client';

import { useState } from 'react';
import { formatCurrency } from '@/utils/formatters';

interface WatchlistItem {
  stock_id: number;
  symbol: string;
  company_name: string;
}

interface PurchaseFromWatchlistModalProps {
  stock: WatchlistItem;
  onClose: () => void;
}

export default function PurchaseFromWatchlistModal({ stock, onClose }: PurchaseFromWatchlistModalProps) {
  const [shares, setShares] = useState<string>('1');
  const [price, setPrice] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const response = await fetch('/api/user/stocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stock_id: stock.stock_id,
          shares: sharesNum,
          purchase_price: priceNum,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to purchase stock');
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
        <h2 id="modal-title" className="text-2xl font-bold text-gray-800 mb-6">Add to Portfolio</h2>
        
        <div className="mb-6 p-4 bg-gray-50 rounded-lg" aria-label="Stock Information">
          <p className="font-semibold text-gray-800">{stock.symbol}</p>
          <p className="text-sm text-gray-600">{stock.company_name}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="purchase-shares" className="block text-sm font-medium text-gray-700 mb-2">
              Number of Shares
            </label>
            <input
              id="purchase-shares"
              type="number"
              step="0.0001"
              min="0"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus-ring"
              placeholder="e.g., 10"
              required
            />
          </div>

          <div>
            <label htmlFor="purchase-price" className="block text-sm font-medium text-gray-700 mb-2">
              Purchase Price per Share ($)
            </label>
            <input
              id="purchase-price"
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus-ring"
              placeholder="e.g., 150.00"
              required
            />
          </div>

          {price && shares && !isNaN(parseFloat(shares)) && !isNaN(parseFloat(price)) && (
            <div className="p-3 bg-green-50 rounded-lg" aria-live="polite">
              <p className="text-sm text-gray-600">
                Total Cost: <span className="font-semibold text-gray-800">
                  {formatCurrency(parseFloat(shares) * parseFloat(price))}
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
              style={{ backgroundColor: 'var(--brand-green-700)' }}
              className="px-6 py-2 text-white rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 focus-ring"
              disabled={loading}
            >
              {loading ? 'Adding...' : 'Add to Portfolio'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
