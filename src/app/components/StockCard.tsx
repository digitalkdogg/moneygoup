'use client';

import { memo, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { formatCurrency, formatNumber } from '@/utils/formatters';

export type StockCardAction = {
  key: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'neutral';
  onClick: (symbol: string) => void;
  stopPropagation?: boolean; // default true
};

export type StockCardMetric = {
  key: string;
  label: string;
  value: string; // preformatted
  tone?: 'positive' | 'negative' | 'neutral';
};

export interface UnifiedStockCardProps {
  symbol: string;
  companyName?: string;
  shares?: number;
  analystRec?: string | null;
  analysts?: number | null;

  price?: {
    current: number;
    changePct?: number | null;
    avgPrice?: number | null; // portfolio uses this
  };

  metrics?: StockCardMetric[]; // flexible for earnings / 6M MA / etc.

  actions?: StockCardAction[]; // 0..n actions

  onCardClick?: (symbol: string) => void;
  className?: string;
}

const getAnalystColor = (rec: string | null): string => {
  if (!rec) return 'text-gray-600';
  const lower = rec.toLowerCase();
  if (lower.includes('strong buy')) return 'text-green-600';
  if (lower.includes('buy')) return 'text-teal-600';
  if (lower.includes('sell')) return 'text-red-600';
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

const getMetricToneColor = (tone?: 'positive' | 'negative' | 'neutral'): string => {
  switch (tone) {
    case 'positive': return 'text-green-600';
    case 'negative': return 'text-red-600';
    default: return 'text-gray-900';
  }
};

const getActionVariantStyles = (variant?: 'primary' | 'secondary' | 'danger' | 'neutral'): string => {
  switch (variant) {
    case 'primary': return 'bg-green-600 text-white hover:opacity-90';
    case 'secondary': return 'bg-gray-600 text-white hover:bg-gray-500';
    case 'danger': return 'bg-red-600 text-white hover:bg-red-500';
    case 'neutral': return 'border-2 border-gray-300 text-gray-700 hover:bg-gray-50';
    default: return 'bg-green-600 text-white hover:opacity-90';
  }
};

const StockCard = ({
  symbol,
  companyName,
  shares,
  analystRec,
  analysts,
  price,
  metrics = [],
  actions = [],
  onCardClick,
  className = "",
}: UnifiedStockCardProps) => {
  const router = useRouter();
  const [isHovered, setIsHovered] = useState(false);

  const handleCardClick = () => {
    if (onCardClick) {
      onCardClick(symbol);
    } else {
      router.push(`/search/${symbol}`);
    }
  };

  const isPositive = price?.changePct !== undefined && price.changePct !== null && price.changePct >= 0;
  const priceColor = isPositive ? 'text-green-600' : 'text-red-600';
  const analystDisplay = analysts ? `${analysts} analysts` : 'No analyst data';

  return (
    <div
      className={`w-full max-w-sm bg-[#fbf9fa] border border-gray-200 rounded-2xl shadow-md hover:shadow-lg hover:-translate-y-1 transition-all duration-200 cursor-pointer flex flex-col h-full ${className}`}
      style={{
        boxShadow: isHovered ? '0 12px 24px rgba(0,0,0,0.12)' : '0 2px 12px rgba(0,0,0,0.07)',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleCardClick}
    >
      {/* Header Row */}
      <div className="flex items-start justify-between p-5 border-b border-gray-100">
        <div>
          <div className="text-2xl font-bold text-gray-900">{symbol}</div>
          {companyName && (
            <div className="text-xs text-gray-500 font-medium mt-1 truncate max-w-[200px]">{companyName}</div>
          )}
          {shares !== undefined && (
            <div className="text-sm text-gray-500 font-medium mt-1">{formatNumber(shares, 2, true)} shares</div>
          )}
        </div>
      </div>

      {/* Price Row */}
      {price && (
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-end justify-between mb-3">
            <div className="text-3xl font-bold text-gray-900">{formatCurrency(price.current, 2)}</div>
            {price.changePct !== null && price.changePct !== undefined && (
              <div
                className={`px-3 py-1 rounded-full text-sm font-semibold ${priceColor} bg-opacity-10 ${
                  isPositive ? 'bg-green-50' : 'bg-red-50'
                }`}
              >
                {isPositive ? '+' : ''}{formatNumber(price.changePct, 2)}%
              </div>
            )}
          </div>
          {price.avgPrice !== null && price.avgPrice !== undefined && (
            <div className="text-xs text-gray-500 font-medium mb-2">Avg {formatCurrency(price.avgPrice, 2)}</div>
          )}
          <div className={`text-xs font-semibold ${getAnalystColor(analystRec || null)}`}>
            {formatRecommendation(analystRec || null)} • {analystDisplay}
          </div>
        </div>
      )}

      {/* Metrics Grid */}
      {metrics.length > 0 && (
        <div className="px-5 py-4 flex-grow">
          <div className="grid grid-cols-2 gap-4">
            {metrics.map((metric, idx) => (
              <div key={metric.key} className={idx % 2 === 1 ? 'text-right' : ''}>
                <div className="text-xs text-gray-500 uppercase font-semibold tracking-wide">{metric.label}</div>
                <div className={`text-lg font-bold mt-1 ${getMetricToneColor(metric.tone)}`}>
                  {metric.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      {actions.length > 0 && (
        <div className="flex gap-3 p-5 mt-auto" onClick={(e) => e.stopPropagation()}>
          {actions.map((action) => (
            <button
              key={action.key}
              onClick={(e) => {
                if (action.stopPropagation !== false) {
                  e.stopPropagation();
                }
                action.onClick(symbol);
              }}
              className={`flex-1 py-3 font-bold rounded-lg transition-all min-h-[44px] text-sm ${getActionVariantStyles(action.variant)}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(StockCard);
