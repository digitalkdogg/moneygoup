'use client';

import { memo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatCurrency, formatNumber } from '@/utils/formatters';

interface StockCardProps {
  symbol: string;
  shares: number;
  analystRec: string | null;
  analysts: number | null;
  avgPrice: number;
  currentPrice: number;
  pctChange: number;
  dailyEarnings: number;
  lifetimeEarnings: number;
  positionValue: number;
  onBuyMore: (symbol: string) => void;
  onSell: (symbol: string) => void;
}

const getAnalystColor = (rec: string | null): string => {
  if (!rec) return 'text-gray-600';
  const lower = rec.toLowerCase();
  if (lower.includes('strong buy')) return 'text-green-600';
  if (lower.includes('buy')) return 'text-teal-600';
  return 'text-gray-600';
};

const formatRecommendation = (rec: string | null): string => {
  if (!rec) return 'None';
  return rec
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
};

export default memo(function StockCard({
  symbol,
  shares,
  analystRec,
  analysts,
  avgPrice,
  currentPrice,
  pctChange,
  dailyEarnings,
  lifetimeEarnings,
  positionValue,
  onBuyMore,
  onSell,
}: StockCardProps) {
  const router = useRouter();
  const [isHovered, setIsHovered] = useState(false);

  // Determine if price is up/down for color coding
  const isPositive = pctChange >= 0;
  const priceColor = isPositive ? 'text-green-600' : 'text-red-600';
  const earningsColor = (value: number) => (value >= 0 ? 'text-green-600' : 'text-red-600');

  const handleCardClick = () => {
    router.push(`/search/${symbol}`);
  };

  // Format analyst count display
  const analystDisplay = analysts ? `${analysts} analysts` : 'No analyst data';

  return (
    <div
      className="w-full max-w-sm bg-white border border-gray-200 rounded-2xl shadow-md hover:shadow-lg hover:-translate-y-1 transition-all duration-200 cursor-pointer"
      style={{
        boxShadow: isHovered ? '0 12px 24px rgba(0,0,0,0.12)' : '0 2px 12px rgba(0,0,0,0.07)',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleCardClick}
    >
      {/* Header Row: Ticker only */}
      <div className="flex items-start justify-between p-5 border-b border-gray-100">
        <div>
          <div className="text-2xl font-bold text-gray-900">{symbol}</div>
          <div className="text-sm text-gray-500 font-medium mt-1">{formatNumber(shares, 2, true)} shares</div>
        </div>
      </div>

      {/* Price Row */}
      <div className="px-5 py-4 border-b border-gray-100">
        <div className="flex items-end justify-between mb-3">
          <div className="text-3xl font-bold text-gray-900">{formatCurrency(currentPrice, 2)}</div>
          <div
            className={`px-3 py-1 rounded-full text-sm font-semibold ${priceColor} bg-opacity-10 ${
              isPositive ? 'bg-green-50' : 'bg-red-50'
            }`}
          >
            {isPositive ? '+' : ''}{formatNumber(pctChange, 2)}%
          </div>
        </div>
        <div className="text-xs text-gray-500 font-medium mb-2">Avg {formatCurrency(avgPrice, 2)}</div>
        {/* Analyst recommendation below avg price */}
        <div className={`text-xs font-semibold ${getAnalystColor(analystRec)}`}>
          {formatRecommendation(analystRec)} • {analystDisplay}
        </div>
      </div>

      {/* Stats Grid (2 columns) */}
      <div className="px-5 py-4">
        {/* Row 1 */}
        <div className="flex justify-between mb-4 pb-4 border-b border-gray-100">
          <div>
            <div className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Daily Earnings</div>
            <div className={`text-lg font-bold mt-1 ${earningsColor(dailyEarnings)}`}>
              {dailyEarnings >= 0 ? '+' : ''}{formatCurrency(dailyEarnings, 2)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Lifetime Earnings</div>
            <div className={`text-lg font-bold mt-1 ${earningsColor(lifetimeEarnings)}`}>
              {lifetimeEarnings >= 0 ? '+' : ''}{formatCurrency(lifetimeEarnings, 2)}
            </div>
          </div>
        </div>

        {/* Row 2 */}
        <div className="flex justify-between">
          <div>
            <div className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Position Value</div>
            <div className="text-lg font-bold text-gray-900 mt-1">{formatCurrency(positionValue, 2)}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Total Shares</div>
            <div className="text-lg font-bold text-gray-900 mt-1">{formatNumber(shares, 2, true)}</div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 p-5" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onBuyMore(symbol)}
          style={{ backgroundColor: '#16a34a' }}
          className="flex-1 py-3 text-white font-bold rounded-lg hover:opacity-90 transition-opacity min-h-[44px]"
        >
          Buy More
        </button>
        <button
          onClick={() => onSell(symbol)}
          className="flex-1 py-3 border-2 border-gray-300 text-gray-700 font-bold rounded-lg hover:bg-gray-50 transition-colors min-h-[44px]"
        >
          Sell
        </button>
      </div>
    </div>
  );
});
