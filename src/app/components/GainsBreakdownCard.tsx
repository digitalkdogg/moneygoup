'use client';

import React from 'react';
import { PortfolioTotals } from '@/types/dashboard';
import { formatCurrency, formatNumber } from '@/utils/formatters';

interface GainsBreakdownCardProps {
  totals: PortfolioTotals | null;
  loading: boolean;
}

const GainsBreakdownCard: React.FC<GainsBreakdownCardProps> = ({ totals, loading }) => {
  if (loading && !totals) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm animate-pulse h-full">
        <div className="h-4 w-32 bg-gray-200 rounded mb-3"></div>
        <div className="flex gap-4 items-center">
          <div className="w-24 h-24 rounded-full border-8 border-gray-100 flex-shrink-0"></div>
          <div className="flex-grow space-y-2.5">
            <div className="h-3 bg-gray-100 rounded w-full"></div>
            <div className="h-3 bg-gray-100 rounded w-full"></div>
            <div className="h-3 bg-gray-100 rounded w-4/5"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!totals || totals.marketValue === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm h-full flex flex-col justify-center items-center text-center">
        <p className="text-gray-500 text-sm font-medium">No positions in portfolio yet.</p>
        <p className="text-xs text-gray-500 mt-1">Gains breakdown will appear once you add stocks.</p>
      </div>
    );
  }

  // Calculate percentages for donut chart
  // Net Gain/Loss vs Cost Basis
  const costBasis = totals.costBasis;
  const netGain = totals.unrealizedNet;
  
  // For visualization: we'll show Cost Basis, Gains, and Losses
  const totalForChart = totals.costBasis + totals.unrealizedGain + totals.unrealizedLoss;
  const gainPct = (totals.unrealizedGain / totalForChart) * 100;
  const lossPct = (totals.unrealizedLoss / totalForChart) * 100;
  const costPct = (totals.costBasis / totalForChart) * 100;

  // Simple CSS conic-gradient for donut
  const donutGradient = `conic-gradient(
    #a8d78d 0% ${gainPct}%,
    #dc2626 ${gainPct}% ${gainPct + lossPct}%,
    #e5e7eb ${gainPct + lossPct}% 100%
  )`;

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-md h-full">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-2 h-2 rounded-full bg-blue-500"></div>
        <h3 className="text-base font-bold text-gray-800">Gains Breakdown</h3>
      </div>

      <div className="flex items-center gap-4">
        {/* Donut Chart */}
        <div className="relative w-24 h-24 flex-shrink-0">
          <div className="w-full h-full rounded-full" style={{ background: donutGradient }}></div>
          <div className="absolute inset-[14px] bg-white rounded-full flex items-center justify-center flex-col shadow-inner">
            <span className={`text-sm font-extrabold leading-none ${netGain >= 0 ? 'text-green-700' : 'text-red-600'}`}>
              {netGain >= 0 ? '+' : ''}{formatNumber(totals.unrealizedPct, 1)}%
            </span>
            <span className="text-[8px] text-gray-600 font-bold uppercase mt-0.5">NET P/L</span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex-1 space-y-2">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: '#a8d78d' }}></div>
              <span className="text-base text-gray-500">Unrealized Gains</span>
            </div>
            <span className="text-base text-green-700 font-bold">{formatCurrency(totals.unrealizedGain, 0)}</span>
          </div>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0"></div>
              <span className="text-base text-gray-500">Unrealized Losses</span>
            </div>
            <span className="text-base text-red-600 font-bold">-{formatCurrency(totals.unrealizedLoss, 0)}</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-gray-100">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-gray-300 flex-shrink-0"></div>
              <span className="text-base text-gray-600 font-semibold">Cost Basis</span>
            </div>
            <span className="text-base text-gray-900 font-bold">{formatCurrency(totals.costBasis, 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GainsBreakdownCard;
