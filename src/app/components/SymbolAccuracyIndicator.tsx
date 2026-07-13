'use client';

import { useEffect, useState } from 'react';
import { createLogger } from '@/utils/logger';

const logger = createLogger('SymbolAccuracyIndicator');

interface SymbolAccuracy {
  status: 'ready' | 'insufficient_data' | 'no_data';
  symbol?: string;
  message?: string;
  total_resolved?: number;
  horizons?: {
    '1_month': {
      resolved_count: number;
      direction_accuracy_pct: number | null;
      direction_correct_count: number;
      direction_resolved_count: number;
    };
  };
}

interface Props {
  ticker: string;
}

export default function SymbolAccuracyIndicator({ ticker }: Props) {
  const [data, setData] = useState<SymbolAccuracy | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAccuracy = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/analytics/model-accuracy?symbol=${ticker}`);
        if (!res.ok) throw new Error('Failed to fetch symbol accuracy');
        const json = await res.json();
        setData(json);
      } catch (err) {
        logger.error('Failed to fetch symbol accuracy', { ticker, error: err });
      } finally {
        setLoading(false);
      }
    };

    if (ticker) fetchAccuracy();
  }, [ticker]);

  if (loading || !data) {
    return null;
  }

  if (data.status === 'no_data' || data.status === 'insufficient_data') {
    return null;
  }

  const month1 = data.horizons?.['1_month'];
  if (!month1 || month1.direction_accuracy_pct === null || !month1.direction_resolved_count) {
    return null;
  }

  const accuracy = month1.direction_accuracy_pct;
  const correct  = month1.direction_correct_count;
  const total    = month1.direction_resolved_count;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="text-gray-700">
          Past 1-month predictions for <strong>{ticker}</strong>:
        </span>
        <span className="font-semibold text-blue-600 text-lg">
          {correct}/{total} correct
        </span>
        <span className="text-gray-600">({accuracy}%)</span>
      </div>
      <p className="text-xs text-gray-600 mt-1">
        This shows the historical direction accuracy of the model for this stock.
      </p>
    </div>
  );
}
