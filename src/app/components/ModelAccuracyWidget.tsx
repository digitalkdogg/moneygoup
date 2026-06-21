'use client';

import { useEffect, useState } from 'react';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ModelAccuracyWidget');

interface Horizon {
  proximity_accuracy_pct: number | null;
  resolved_count: number;
  high_accuracy_count: number;
}

interface AccuracyResponse {
  status: 'ready' | 'insufficient_data';
  message?: string;
  total_records?: number;
  total_accuracy_pct?: number | null;
  last_resolved_at?: string;
  horizons?: {
    '1_week': Horizon;
    '1_month': Horizon;
    '6_month': Horizon;
    '1_year': Horizon;
  };
}

type HorizonKey = '1_week' | '1_month' | '6_month' | '1_year';

const HORIZON_LABELS: Record<HorizonKey, string> = {
  '1_week': '1 Week',
  '1_month': '1 Month',
  '6_month': '6 Months',
  '1_year': '1 Year',
};

export default function ModelAccuracyWidget() {
  const [data, setData] = useState<AccuracyResponse | null>(null);
  const [selectedHorizon, setSelectedHorizon] = useState<HorizonKey>('1_month');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAccuracy = async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/analytics/model-accuracy?skip_cache=true');
        if (!res.ok) throw new Error('Failed to fetch accuracy data');
        const json = await res.json();
        console.log('[ModelAccuracyWidget] API Response:', json);
        setData(json);
        setError(null);
      } catch (err) {
        logger.error('Failed to fetch model accuracy', { error: err });
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchAccuracy();
  }, []);

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Model Accuracy</h3>
        <div className="flex items-center justify-center h-32">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Model Accuracy</h3>
        <p className="text-red-600 text-sm">{error || 'Failed to load accuracy data'}</p>
      </div>
    );
  }

  if (data.status === 'insufficient_data') {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Model Accuracy</h3>
        <div className="bg-blue-50 border border-blue-200 rounded p-4">
          <p className="text-blue-800 text-sm">{data.message}</p>
          {data.total_records && (
            <p className="text-blue-700 text-xs mt-2">
              Currently tracking {data.total_records} predictions...
            </p>
          )}
        </div>
      </div>
    );
  }

  const currentHorizon = data.horizons?.[selectedHorizon];
  if (!currentHorizon) {
    return null;
  }

  const proximityAccuracy = currentHorizon.proximity_accuracy_pct;
  const resolvedCount = currentHorizon.resolved_count;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-800">Model Accuracy</h3>
        <span className="text-xs text-gray-500">
          {data.last_resolved_at && `Updated ${new Date(data.last_resolved_at).toLocaleDateString()}`}
        </span>
      </div>

      {/* Horizon Selector — native <select> on mobile, button group on md+.
          Both pathways advertise their active selection to assistive tech
          (aria-pressed on the buttons, native semantics on the select) and
          carry a visible label for screen readers. */}
      <div className="mb-6 md:hidden">
        <label
          htmlFor="model-accuracy-horizon"
          className="block text-xs font-medium text-gray-700 mb-1"
        >
          Prediction horizon
        </label>
        <select
          id="model-accuracy-horizon"
          value={selectedHorizon}
          onChange={(e) => setSelectedHorizon(e.target.value as HorizonKey)}
          className="block w-full min-h-[44px] rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:border-blue-600"
        >
          {(Object.keys(HORIZON_LABELS) as HorizonKey[]).map((horizon) => (
            <option key={horizon} value={horizon}>
              {HORIZON_LABELS[horizon]}
            </option>
          ))}
        </select>
      </div>

      <div
        role="group"
        aria-label="Prediction horizon"
        className="hidden md:flex gap-2 mb-6 flex-wrap"
      >
        {(Object.keys(HORIZON_LABELS) as HorizonKey[]).map((horizon) => {
          const isActive = selectedHorizon === horizon;
          return (
            <button
              key={horizon}
              type="button"
              onClick={() => setSelectedHorizon(horizon)}
              aria-pressed={isActive}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {HORIZON_LABELS[horizon]}
            </button>
          );
        })}
      </div>

      {/* Three-Column Metrics Row — stacks on mobile, 3-up on md+ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Overall Total Accuracy */}
        {typeof data.total_accuracy_pct === 'number' && data.total_accuracy_pct !== null && (
          <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg p-6 border border-green-200">
            <div className="text-center">
              <p className="text-gray-600 text-sm mb-3">Overall Model Accuracy</p>
              <p className="text-4xl font-bold text-green-600 mb-2">
                {data.total_accuracy_pct.toFixed(1)}%
              </p>
              <p className="text-xs text-gray-600">
                All predictions & timeframes
              </p>
            </div>
          </div>
        )}

        {/* Proximity Accuracy */}
        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
          <div className="text-center">
            <p className="text-gray-600 text-sm mb-3">Proximity Accuracy</p>
            <p className="text-4xl font-bold text-blue-600 mb-2">
              {typeof proximityAccuracy === 'number' && proximityAccuracy !== null ? `${proximityAccuracy.toFixed(1)}%` : '—'}
            </p>
            <p className="text-xs text-gray-600">
              {HORIZON_LABELS[selectedHorizon]} ({resolvedCount} predictions)
            </p>
          </div>
        </div>

        {/* High Accuracy Count */}
        {typeof currentHorizon?.high_accuracy_count === 'number' && (
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-lg p-6 border border-amber-200">
            <div className="text-center">
              <p className="text-gray-600 text-sm mb-3">High Accuracy (≥95%)</p>
              <p className="text-4xl font-bold text-amber-600 mb-2">
                {currentHorizon.high_accuracy_count}/{resolvedCount}
              </p>
              <p className="text-xs text-gray-600">
                {HORIZON_LABELS[selectedHorizon]} predictions
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Data Freshness */}
      <div className="mt-4 pt-4 border-t border-gray-200">
        <p className="text-xs text-gray-500">
          This model accuracy is computed daily from live market data and represents the historical
          performance of the prediction engine across all users.
        </p>
      </div>
    </div>
  );
}
