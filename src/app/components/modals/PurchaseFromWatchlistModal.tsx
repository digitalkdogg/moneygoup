'use client';

import { useState, useEffect } from 'react';
import { formatCurrency } from '@/utils/formatters';

interface WatchlistItem {
  stock_id: number;
  symbol: string;
  company_name: string;
}

interface PurchaseFromWatchlistModalProps {
  stock: WatchlistItem;
  onClose: () => void;
  onPurchased?: (stockId: number) => void;
}

export default function PurchaseFromWatchlistModal({ stock, onClose, onPurchased }: PurchaseFromWatchlistModalProps) {
  const [shares, setShares] = useState<string>('1');
  const [price, setPrice] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const sharesNum = parseFloat(shares);
    const priceNum = parseFloat(price);
    if (isNaN(sharesNum) || sharesNum <= 0) { setError('Shares must be a positive number'); return; }
    if (isNaN(priceNum) || priceNum <= 0) { setError('Price must be a positive number'); return; }
    setLoading(true);
    try {
      const response = await fetch('/api/user/stocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock_id: stock.stock_id, shares: sharesNum, purchase_price: priceNum }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to purchase stock');
      }
      onPurchased?.(stock.stock_id);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const totalCost = !isNaN(parseFloat(shares)) && !isNaN(parseFloat(price))
    ? parseFloat(shares) * parseFloat(price)
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 id="modal-title" className="text-base font-bold text-gray-900">Add to Portfolio</h2>
            <p className="text-xs text-gray-600 mt-0.5">{stock.symbol} · {stock.company_name}</p>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-700 transition-colors p-1" aria-label="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <form onSubmit={handleSubmit} className="space-y-4" id="purchase-form">
            <div>
              <label htmlFor="purchase-shares" className="block text-sm font-medium text-gray-700 mb-1">
                Number of Shares
              </label>
              <input
                id="purchase-shares"
                type="number" step="0.0001" min="0"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="e.g., 10"
                required
              />
            </div>
            <div>
              <label htmlFor="purchase-price" className="block text-sm font-medium text-gray-700 mb-1">
                Purchase Price per Share ($)
              </label>
              <input
                id="purchase-price"
                type="number" step="0.01" min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="e.g., 150.00"
                required
              />
            </div>

            {totalCost !== null && (
              <div className="bg-green-50 rounded-xl p-4" aria-live="polite">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total Cost</span>
                  <span className="font-semibold text-gray-800">{formatCurrency(totalCost)}</span>
                </div>
              </div>
            )}

            {error && <p className="text-red-600 text-sm font-medium" aria-live="assertive">{error}</p>}
          </form>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="purchase-form"
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand-green-700)] rounded-lg hover:opacity-90 transition-colors disabled:opacity-50"
          >
            {loading ? 'Adding...' : 'Add to Portfolio'}
          </button>
        </div>
      </div>
    </div>
  );
}
