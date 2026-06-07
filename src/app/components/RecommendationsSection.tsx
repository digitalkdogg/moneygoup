'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { DashboardRecommendationsResponse, DashboardRecommendation } from '@/types/dashboard';
import { formatNumber, formatCurrency } from '@/utils/formatters';
import MiniDataCard from './cards/MiniDataCard';
import { GpsTooltip } from './cards/GpsTooltip';

interface RecommendationsSectionProps {
  scopes?: Array<DashboardRecommendation['scope']>;
}

const RecommendationsSection: React.FC<RecommendationsSectionProps> = ({ scopes }) => {
  const [data, setData] = useState<DashboardRecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getBadgeText = (rec: DashboardRecommendation) => {
    if (rec.action === 'BUY') {
      return rec.scope === 'portfolio' ? 'BUY MORE' : 'BUY';
    }
    return 'SELL';
  };

  const getScopeBadge = (rec: DashboardRecommendation) => {
    if (rec.scope === 'etf_holding') {
      return (
        <span className="px-1 rounded-sm uppercase text-[8px] font-bold bg-teal-100 text-teal-700 border border-teal-200">
          etf holding
        </span>
      );
    }
    return (
      <span className={`px-1 rounded-sm uppercase text-[8px] font-bold ${
        rec.scope === 'portfolio'
          ? 'bg-blue-100 text-blue-700 border border-blue-200'
          : rec.scope === 'watchlist'
            ? 'bg-amber-100 text-amber-700 border border-amber-200'
            : 'bg-purple-100 text-purple-700 border border-purple-200'
      }`}>
        {rec.scope}
      </span>
    );
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
        <button onClick={fetchData} className="mt-2 text-blue-600 hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <section className="mb-8">
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl" role="img" aria-label="lightbulb">💡</span>
            <h3 className="text-xl font-bold text-gray-800">Recommendations</h3>
          </div>
          <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full border border-gray-200 inline-block w-fit">
            Based on 1-month prediction
          </span>
        </div>
        
        {(() => {
          const filtered = scopes
            ? (data?.recommendations ?? []).filter(r => scopes.includes(r.scope))
            : (data?.recommendations ?? []);
          return (!filtered.length) ? (
          <div className="flex flex-col items-center justify-center py-10 bg-gray-50 rounded-lg border border-dashed border-gray-200">
            <p className="text-gray-500 font-medium">No actionable recommendations at this time.</p>
            <p className="text-xs text-gray-400 mt-1">Check back later as market prices and predictions update.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((rec) => (
              <Link key={`${rec.scope}-${rec.symbol}`} href={`/search/${rec.symbol}`}>
                <MiniDataCard
                  label={rec.symbol}
                  badge={getBadgeText(rec)}
                  primaryText={`Current ${formatCurrency(rec.currentPrice)}`}
                  secondaryText={
                    <div className="flex items-center gap-1">
                      <span>GPS Score: {rec.gpsScore !== null && typeof rec.gpsScore === 'number' ? rec.gpsScore.toFixed(1) : 'N/A'}</span>
                      {rec.gpsScore !== null && (
                        <GpsTooltip score={rec.gpsScore} breakdown={rec.gpsBreakdown} symbol={rec.symbol} />
                      )}
                    </div>
                  }
                  tone={rec.action === 'BUY' ? 'positive' : 'negative'}
                  subLabel={
                    <span className="flex items-center gap-1">
                      {rec.scope === 'etf_holding' ? (
                        <span>In {rec.etfTicker}</span>
                      ) : (
                        <span>Updated: {new Date(rec.lastRequestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                      <span className="mx-1">•</span>
                      {getScopeBadge(rec)}
                    </span>
                  }
                />
              </Link>
            ))}
          </div>
        );
        })()}

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
