'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface EtfRec {
  id: number;
  etfTicker: string;
  stockTicker: string;
  gpsScore: number | null;
  predictedChangePct: number | null;
  confidenceScore: number | null;
  recommendationReason: string | null;
  seen: boolean;
  snapshotDate: string;
}

export default function EtfHoldingsAlert() {
  const router = useRouter();
  const [recs, setRecs] = useState<EtfRec[]>([]);
  const [dismissing, setDismissing] = useState<Set<number>>(new Set());

  const fetchRecs = useCallback(async () => {
    try {
      const res = await fetch('/api/etf/holdings-recommendation?unseen=true');
      if (!res.ok) return;
      const data = await res.json();
      setRecs(data.recommendations ?? []);
    } catch {}
  }, []);

  useEffect(() => { fetchRecs(); }, [fetchRecs]);

  const dismiss = async (ids: number[]) => {
    setDismissing(prev => new Set([...prev, ...ids]));
    try {
      await fetch('/api/etf/holdings-recommendation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      setRecs(prev => prev.filter(r => !ids.includes(r.id)));
    } catch {}
    setDismissing(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
  };

  if (recs.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-heading">ETF Holdings Alerts</h2>
        {recs.length > 1 && (
          <button
            onClick={() => dismiss(recs.map(r => r.id))}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
          >
            Dismiss all
          </button>
        )}
      </div>
      <div className="space-y-3">
        {recs.map(rec => {
          const gpsColor =
            rec.gpsScore !== null && rec.gpsScore >= 65 ? 'text-green-700 bg-green-50' :
            rec.gpsScore !== null && rec.gpsScore >= 45 ? 'text-yellow-700 bg-yellow-50' :
            'text-gray-600 bg-gray-50';

          return (
            <div
              key={rec.id}
              className="flex items-start gap-4 bg-white border border-green-100 rounded-xl p-4 shadow-sm"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-green-50 border border-green-200 flex items-center justify-center text-green-700 font-bold text-sm">
                {rec.stockTicker.slice(0, 2)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800">
                  <button
                    onClick={() => router.push(`/search/${rec.stockTicker}`)}
                    className="text-[#017e3b] hover:underline cursor-pointer"
                  >
                    {rec.stockTicker}
                  </button>
                  {' '}is a top holding of{' '}
                  <button
                    onClick={() => router.push(`/search/${rec.etfTicker}`)}
                    className="text-[#017e3b] hover:underline cursor-pointer"
                  >
                    {rec.etfTicker}
                  </button>
                  {' '}and is showing strong signals.
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {rec.gpsScore !== null && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${gpsColor}`}>
                      GPS {rec.gpsScore.toFixed(1)}
                    </span>
                  )}
                  {rec.predictedChangePct !== null && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold text-blue-700 bg-blue-50">
                      +{rec.predictedChangePct.toFixed(1)}% predicted
                    </span>
                  )}
                  {rec.confidenceScore !== null && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold text-gray-600 bg-gray-100">
                      {rec.confidenceScore.toFixed(0)}% confidence
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => dismiss([rec.id])}
                disabled={dismissing.has(rec.id)}
                aria-label="Dismiss"
                className="flex-shrink-0 text-gray-300 hover:text-gray-500 disabled:opacity-40 transition-colors cursor-pointer mt-0.5"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
