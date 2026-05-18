// src/app/components/modals/SellModal.tsx
'use client';

import { useState } from 'react';
import { formatNumber, formatCurrency } from '@/utils/formatters';

interface PortfolioItem {
  stock_id: number;
  symbol: string;
  company_name: string;
  shares: number;
  purchase_price: number;
}

interface SellModalProps {
  stock: PortfolioItem;
  onClose: () => void;
}

export default function SellModal({ stock, onClose }: SellModalProps) {
  const [sellType, setSellType] = useState<'all' | 'partial'>('all');
  const [shares, setShares] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [realizingGain, setRealizingGain] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxShares = parseFloat(stock.shares as any);

  // Calculate realized gain
  const calculateGain = () => {
    const sharesNum = sellType === 'all' ? maxShares : parseFloat(shares);
    const priceNum = parseFloat(price);

    if (!isNaN(sharesNum) && !isNaN(priceNum) && sharesNum > 0 && priceNum > 0) {
      const currentAvgPrice = parseFloat(stock.purchase_price as any);
      const gain = (priceNum - currentAvgPrice) * sharesNum;
      setRealizingGain(gain);
    } else {
      setRealizingGain(null);
    }
  };

  const handleSellTypeChange = (type: 'all' | 'partial') => {
    setSellType(type);
    setShares('');
    setRealizingGain(null);
  };

  const handlePriceChange = (val: string) => {
    setPrice(val);
    const sharesNum = sellType === 'all' ? maxShares : parseFloat(shares);
    if (!isNaN(sharesNum) && sharesNum > 0) {
      const priceNum = parseFloat(val);
      if (!isNaN(priceNum) && priceNum > 0) {
        const currentAvgPrice = parseFloat(stock.purchase_price as any);
        const gain = (priceNum - currentAvgPrice) * sharesNum;
        setRealizingGain(gain);
      }
    }
  };

  const handleSharesChange = (val: string) => {
    setShares(val);
    const sharesNum = parseFloat(val);
    if (!isNaN(sharesNum) && sharesNum > 0) {
      const priceNum = parseFloat(price);
      if (!isNaN(priceNum) && priceNum > 0) {
        const currentAvgPrice = parseFloat(stock.purchase_price as any);
        const gain = (priceNum - currentAvgPrice) * sharesNum;
        setRealizingGain(gain);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const priceNum = parseFloat(price);

    if (isNaN(priceNum) || priceNum <= 0) {
      setError('Price must be a positive number');
      return;
    }

    if (sellType === 'partial') {
      const sharesNum = parseFloat(shares);
      if (isNaN(sharesNum) || sharesNum <= 0) {
        setError('Shares must be a positive number');
        return;
      }
      if (sharesNum > maxShares) {
        setError(`Cannot sell more than ${formatNumber(maxShares, 4)} shares`);
        return;
      }
    }

    setLoading(true);

    try {
      const response = await fetch(`/api/user/stocks/${stock.stock_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: sellType === 'all' ? 'sell_all' : 'sell_partial',
          shares: sellType === 'partial' ? parseFloat(shares) : undefined,
          price: priceNum,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to sell shares');
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
        <h2 id="modal-title" className="text-2xl font-bold text-gray-800 mb-6">Sell Shares</h2>
        
        <div className="mb-6 p-4 bg-gray-50 rounded-lg space-y-2" aria-label="Stock Information">
          <div className="flex justify-between">
            <span className="text-sm text-gray-600">Symbol:</span>
            <span className="font-semibold text-gray-800">{stock.symbol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-600">Current Shares:</span>
            <span className="font-semibold text-gray-800">{formatNumber(maxShares, 4)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-600">Avg Cost:</span>
            <span className="font-semibold text-gray-800">{formatCurrency(stock.purchase_price)}</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="block text-sm font-medium text-gray-700">Sell Type</legend>
            <div className="space-y-2">
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="sellType"
                  value="all"
                  checked={sellType === 'all'}
                  onChange={() => handleSellTypeChange('all')}
                  className="mr-2 focus-ring"
                />
                <span className="text-sm text-gray-700">Sell All ({maxShares.toFixed(4)} shares)</span>
              </label>
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="sellType"
                  value="partial"
                  checked={sellType === 'partial'}
                  onChange={() => handleSellTypeChange('partial')}
                  className="mr-2 focus-ring"
                />
                <span className="text-sm text-gray-700">Sell Partial</span>
              </label>
            </div>
          </fieldset>

          {sellType === 'partial' && (
            <div>
              <label htmlFor="sell-shares" className="block text-sm font-medium text-gray-700 mb-2">
                Number of Shares to Sell
              </label>
              <input
                id="sell-shares"
                type="number"
                step="0.0001"
                min="0"
                max={maxShares}
                value={shares}
                onChange={(e) => {
                  handleSharesChange(e.target.value);
                  calculateGain();
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 focus-ring"
                placeholder="e.g., 5"
                required
              />
            </div>
          )}

          <div>
            <label htmlFor="sell-price" className="block text-sm font-medium text-gray-700 mb-2">
              Selling Price per Share ($)
            </label>
            <input
              id="sell-price"
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => {
                handlePriceChange(e.target.value);
                calculateGain();
              }}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 focus-ring"
              placeholder="e.g., 170.00"
              required
            />
          </div>

          <div aria-live="polite">
            {realizingGain !== null && (
              <div className={`p-4 rounded-lg ${realizingGain >= 0 ? 'bg-green-50' : 'bg-red-50'} space-y-2`}>
                <p className={`text-sm ${realizingGain >= 0 ? 'text-gray-600' : 'text-gray-600'}`}>
                  Shares to Sell: <span className="font-semibold text-gray-800">
                    {formatNumber((sellType === 'all' ? maxShares : parseFloat(shares)), 4)}
                  </span>
                </p>
                <p className={`text-sm ${realizingGain >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  Realized Gain/Loss: <span className="font-semibold">
                    {realizingGain >= 0 ? '+' : ''}{formatCurrency(realizingGain)} (
                    {(realizingGain >= 0 ? '+' : '')}
                    {formatNumber(((realizingGain / (parseFloat(stock.purchase_price as any) * (sellType === 'all' ? maxShares : parseFloat(shares)))) * 100), 2)}%)
                  </span>
                </p>
              </div>
            )}
          </div>

          {sellType === 'all' && (
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800 font-semibold">⚠️ This will close your position for {stock.symbol}</p>
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
              className="px-6 py-2 text-white bg-green-700 rounded-lg hover:bg-green-800 transition-colors disabled:opacity-50 focus-ring"
              disabled={loading}
            >
              {loading ? 'Selling...' : 'Confirm Sell'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
