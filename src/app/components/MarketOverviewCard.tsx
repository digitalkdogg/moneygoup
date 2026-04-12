'use client';

import React, { useEffect, useState } from 'react';
import { MarketOverviewResponse } from '@/types/dashboard';
import { formatNumber } from '@/utils/formatters';
import MiniDataCard from './cards/MiniDataCard';

const MarketOverviewCard: React.FC = () => {
  const [data, setData] = useState<MarketOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/market/indices');
      if (!res.ok) throw new Error('Failed to fetch market indices');
      const json = await res.json();
      setData(json);
      setError(null);
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
    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm h-full">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2.5 h-2.5 rounded-full bg-green-500"></div>
        <h3 className="font-bold text-gray-800">Market Overview</h3>
      </div>
      
      <div className="grid grid-cols-2 gap-3">
        {data?.indices.map((idx) => (
          <MiniDataCard
            key={idx.symbol}
            label={idx.label}
            primaryText={idx.price ? formatNumber(idx.price, idx.symbol === '^VIX' ? 1 : 0) : '—'}
            secondaryText={idx.changePercent !== null ? `${idx.changePercent >= 0 ? '+' : ''}${formatNumber(idx.changePercent, 2)}%` : '—'}
            tone={idx.changePercent && idx.changePercent >= 0 ? 'positive' : 'negative'}
            primaryClassOverride="text-lg font-extrabold text-gray-900 leading-none mb-1"
          />
        ))}
      </div>
      
      {data?.asOf && (
        <p className="text-[10px] text-gray-400 mt-3 text-right">
          As of {new Date(data.asOf).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
};

export default MarketOverviewCard;
