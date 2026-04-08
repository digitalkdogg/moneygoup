'use client';

import React, { useEffect, useState } from 'react';
import { AnalystRatingsResponse } from '@/types/dashboard';

const getRatingColor = (rating: string): string => {
  const lower = rating.toLowerCase();
  if (lower.includes('strong buy')) return 'bg-green-100 text-green-700 border-green-200';
  if (lower.includes('buy')) return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (lower.includes('hold')) return 'bg-amber-100 text-amber-700 border-amber-200';
  if (lower.includes('sell')) return 'bg-red-100 text-red-700 border-red-200';
  return 'bg-gray-100 text-gray-700 border-gray-200';
};

interface AnalystRatingsCardProps {
  initialData?: AnalystRatingsResponse | null;
}

const AnalystRatingsCard: React.FC<AnalystRatingsCardProps> = ({ initialData }) => {
  const [data, setData] = useState<AnalystRatingsResponse | null>(initialData || null);
  const [loading, setLoading] = useState(initialData ? false : true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    if (initialData) return;
    try {
      setLoading(true);
      const res = await fetch('/api/dashboard/analyst-ratings');
      if (!res.ok) throw new Error('Failed to fetch analyst ratings');
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError('Analyst data unavailable');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setLoading(false);
    } else {
      fetchData();
    }
  }, [initialData]);

  if (loading && !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm animate-pulse h-full">
        <div className="h-6 w-32 bg-gray-200 rounded mb-4"></div>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-8 bg-gray-100 rounded"></div>
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

  if (data?.ratings.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm h-full flex flex-col justify-center items-center text-center">
        <p className="text-gray-500 text-sm font-medium">No ratings available.</p>
        <p className="text-xs text-gray-400 mt-1">Add stocks to your portfolio to see analyst sentiment.</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm h-full">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2.5 h-2.5 rounded-full bg-purple-500"></div>
        <h3 className="font-bold text-gray-800">Analyst Ratings</h3>
      </div>

      <div className="space-y-1 max-h-[220px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-gray-200">
        {data?.ratings.map((rating) => (
          <div key={rating.symbol} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
            <span className="font-bold text-[10px] text-gray-900">{rating.symbol}</span>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${getRatingColor(rating.primary)}`}>
                {rating.primary}
              </span>
              {rating.count !== null && (
                <span className="text-[10px] text-gray-400 font-bold">
                  {rating.count}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      
      {data?.asOf && (
        <p className="text-[10px] text-gray-400 mt-3 text-right">
          As of {new Date(data.asOf).toLocaleDateString()}
        </p>
      )}
    </div>
  );
};

export default AnalystRatingsCard;
