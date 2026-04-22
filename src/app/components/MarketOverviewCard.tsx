'use client';

import React, { useEffect, useState } from 'react';
import { MarketOverviewResponse } from '@/types/dashboard';
import { formatNumber } from '@/utils/formatters';
import { getMarketStatus } from '@/utils/marketStatus';
import MiniDataCard from './cards/MiniDataCard';

const MarketOverviewCard: React.FC = () => {
  const [data, setData] = useState<MarketOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marketStatus, setMarketStatus] = useState(getMarketStatus());

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/market/indices');
      if (!res.ok) throw new Error('Failed to fetch market indices');
      const json = await res.json();
      setData(json);
      setError(null);
      setMarketStatus(getMarketStatus());
    } catch (err) {
      setError('Market data unavailable');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm animate-pulse h-full">
        <div className="h-6 w-32 bg-gray-200 rounded mb-4"></div>
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-16 bg-gray-100 rounded-lg"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm h-full flex flex-col justify-center items-center">
        <p className="text-red-500 text-sm font-medium">{error}</p>
        <button onClick={fetchData} className="mt-2 text-xs text-blue-600 hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-md">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${marketStatus.isOpen ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
          <h3 className="text-xl font-bold text-gray-800">Market Overview</h3>
        </div>
        <span className={`text-xs font-bold px-3 py-1 rounded-full border ${
          marketStatus.isOpen ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          {marketStatus.message}
        </span>
      </div>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
        {data?.indices.map((idx) => (
          <div key={idx.symbol} className="flex flex-col">
            <span className="text-[11px] uppercase font-bold text-gray-400 tracking-wider mb-2">
              {idx.label}
            </span>
            <span className="text-2xl font-extrabold text-gray-900 leading-tight">
              {idx.price ? formatNumber(idx.price, idx.symbol === '^VIX' ? 1 : 0) : '—'}
            </span>
            <span className={`text-sm font-bold mt-1 ${idx.changePercent && idx.changePercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {idx.changePercent !== null ? `${idx.changePercent >= 0 ? '+' : ''}${formatNumber(idx.changePercent, 2)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
      
      {data?.asOf && (
        <p className="text-[10px] text-gray-400 mt-6 text-right">
          As of {new Date(data.asOf).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
};

export default MarketOverviewCard;
