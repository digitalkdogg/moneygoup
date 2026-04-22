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
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm animate-pulse h-full">
        <div className="h-6 w-40 bg-gray-200 rounded mb-4"></div>
        <div className="flex gap-4 items-center h-full">
          <div className="w-32 h-32 rounded-full border-8 border-gray-100 flex-shrink-0"></div>
          <div className="flex-grow space-y-3">
            <div className="h-4 bg-gray-100 rounded w-full"></div>
            <div className="h-4 bg-gray-100 rounded w-full"></div>
            <div className="h-4 bg-gray-100 rounded w-full"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!totals || totals.marketValue === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm h-full flex flex-col justify-center items-center text-center">
        <p className="text-gray-500 text-sm font-medium">No positions in portfolio yet.</p>
        <p className="text-xs text-gray-400 mt-1">Gains breakdown will appear once you add stocks.</p>
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
    <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-md h-full">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-2.5 h-2.5 rounded-full bg-blue-500"></div>
        <h3 className="font-bold text-gray-800">Gains Breakdown</h3>
      </div>

      <div className="flex flex-col gap-8 items-center h-full justify-center">
        {/* Donut Chart */}
        <div className="relative w-40 h-40 flex-shrink-0">
          <div 
            className="w-full h-full rounded-full" 
            style={{ background: donutGradient }}
          ></div>
          <div className="absolute inset-5 bg-white rounded-full flex items-center justify-center flex-col shadow-inner">
            <span className={`text-2xl font-extrabold leading-none ${netGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {netGain >= 0 ? '+' : ''}{formatNumber(totals.unrealizedPct, 1)}%
            </span>
            <span className="text-[10px] text-gray-400 font-bold uppercase mt-1">NET P/L</span>
          </div>
        </div>

        {/* Legend */}
        <div className="w-full bg-gray-50 rounded-xl p-4 border border-gray-100">
          <ul className="space-y-4">
            <li className="flex justify-between items-center text-sm">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#a8d78d' }}></div>
                <span className="text-gray-500 font-medium">Unrealized Gains</span>
              </div>
              <span className="text-green-600 font-bold">{formatCurrency(totals.unrealizedGain, 0)}</span>
            </li>
            <li className="flex justify-between items-center text-sm">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full bg-red-600"></div>
                <span className="text-gray-500 font-medium">Unrealized Losses</span>
              </div>
              <span className="text-red-600 font-bold">-{formatCurrency(totals.unrealizedLoss, 0)}</span>
            </li>
            <li className="flex justify-between items-center text-sm pt-4 border-t border-gray-200">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full bg-gray-300"></div>
                <span className="text-gray-600 font-bold">Cost Basis</span>
              </div>
              <span className="text-gray-900 font-extrabold">{formatCurrency(totals.costBasis, 0)}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default GainsBreakdownCard;
