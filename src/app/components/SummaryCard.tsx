// src/app/components/SummaryCard.tsx
'use client';

import React from 'react';
import { formatCurrency } from '@/utils/formatters';

interface SummaryCardProps {
  label: string;
  value: number | null;
  marketStatus?: 'open' | 'closed';
  tooltip?: string;
  isMissingData?: boolean;
}

const SummaryCard: React.FC<SummaryCardProps> = ({
  label,
  value,
  marketStatus,
  tooltip,
  isMissingData,
}) => {
  const formatValue = (val: number | null) => {
    if (val === null) {
      return <span className="text-gray-500">—</span>;
    }
    const sign = val > 0 ? '+' : '';
    const colorClass = val > 0 ? 'text-green-600' : val < 0 ? 'text-red-600' : 'text-gray-600';
    return <span className={colorClass}>{sign}{formatCurrency(val, 2)}</span>;
  };

  return (
    <div className="p-6 bg-white rounded-2xl shadow-md border border-gray-100 relative">
      <p className="text-sm font-medium text-gray-500 mb-2">{label}</p>
      <p className="text-3xl font-bold">{formatValue(value)}</p>
      {marketStatus === 'closed' && (
        <div className="text-xs text-gray-400 mt-1">Market Closed</div>
      )}
      {isMissingData && tooltip && (
        <div className="absolute top-2 right-2 group">
          <span className="text-xs text-gray-400 cursor-pointer">⚠️</span>
          <div className="absolute bottom-full mb-2 w-48 bg-gray-800 text-white text-xs rounded py-1 px-2 opacity-0 group-hover:opacity-100 transition-opacity">
            {tooltip}
          </div>
        </div>
      )}
    </div>
  );
};

export default SummaryCard;
