'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { DashboardRecommendationsResponse, DashboardRecommendation } from '@/types/dashboard';
import { formatNumber, formatCurrency } from '@/utils/formatters';
import MiniDataCard from './cards/MiniDataCard';

const RecommendationsSection: React.FC = () => {
  const [data, setData] = useState<DashboardRecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getBadgeText = (rec: DashboardRecommendation) => {
    if (rec.action === 'BUY') {
      return rec.scope === 'portfolio' ? 'BUY MORE' : 'BUY';
    }
    return 'SELL';
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/dashboard/recommendations');
      if (!res.ok) throw new Error('Failed to fetch recommendations');
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError('Recommendations unavailable');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading && !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm animate-pulse mb-8">
        <div className="h-7 w-48 bg-gray-200 rounded mb-6"></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-24 bg-gray-100 rounded-lg"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm mb-8 flex flex-col items-center">
        <p className="text-red-500 text-sm font-medium">{error}</p>
        <button onClick={fetchData} className="mt-2 text-xs text-blue-600 hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <section className="mb-8">
      <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl" role="img" aria-label="lightbulb">💡</span>
            <h2 className="text-xl font-bold text-gray-800">Recommendations</h2>
          </div>
          <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full border border-gray-200 inline-block w-fit">
            Based on 1-month prediction
          </span>
        </div>
        
        {(!data?.recommendations || data.recommendations.length === 0) ? (
          <div className="flex flex-col items-center justify-center py-10 bg-gray-50 rounded-lg border border-dashed border-gray-200">
            <p className="text-gray-500 font-medium">No actionable recommendations at this time.</p>
            <p className="text-xs text-gray-400 mt-1">Check back later as market prices and predictions update.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.recommendations.map((rec) => (
              <Link key={rec.symbol} href={`/search/${rec.symbol}`}>
                <MiniDataCard
                  label={rec.symbol}
                  badge={getBadgeText(rec)}
                  primaryText={`Current ${formatCurrency(rec.currentPrice)}`}
                  secondaryText={`1M Pred ${formatCurrency(rec.predictedPrice1m)} • ${rec.deltaPct >= 0 ? '+' : ''}${formatNumber(rec.deltaPct, 2)}%`}
                  tone={rec.action === 'BUY' ? 'positive' : 'negative'}
                  subLabel={`Updated: ${new Date(rec.lastRequestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • ${rec.scope}`}
                />
              </Link>
            ))}
          </div>
        )}
        
        {data?.asOf && (
          <p className="text-[10px] text-gray-400 mt-4 text-right italic">
            Refreshed {new Date(data.asOf).toLocaleTimeString()}
          </p>
        )}
      </div>
    </section>
  );
};

export default RecommendationsSection;
