'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import StockTable from './StockTable';
import { GpsTooltip } from './cards/GpsTooltip';
import { formatPrice, formatPriceChange, formatPercent, getChangeColor, getPredictionColor, calculatePredictionChange } from './cards/formatters';
import { getGpsLabel } from '@/utils/gps';

interface IndustryStocksProps {
  ticker: string;
}

interface IndustryStock {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  gps_score: number | null;
  gps_breakdown: any | null;
  gps_as_of: string | null;
  predictedPriceHorizon: number | null;
  predictedChangePctHorizon: number | null;
}

interface IndustryResponse {
  input: string;
  industry: string;
  horizonLabel?: string;
  stocks: IndustryStock[];
  message?: string;
}

// GPS bands match getGpsLabel thresholds: Strong Buy >=80, Buy >=65, Hold >=45, Sell >=30
function gpsBadgeClass(score: number): string {
  if (score >= 80) return 'bg-green-100 text-green-800 border-green-300';
  if (score >= 65) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (score >= 45) return 'bg-yellow-100 text-yellow-800 border-yellow-200';
  if (score >= 30) return 'bg-orange-100 text-orange-800 border-orange-200';
  return 'bg-red-100 text-red-800 border-red-200';
}

export default function IndustryStocks({ ticker }: IndustryStocksProps) {
  const router = useRouter();
  const [data, setData] = useState<IndustryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchIndustryStocks() {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch(`/api/stock_data/${encodeURIComponent(ticker)}/industry`);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || 'Failed to fetch industry stocks');
        }
        const json: IndustryResponse = await response.json();
        setData(json);
      } catch (err) {
        console.error('Error fetching industry stocks:', err);
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    }
    if (ticker) fetchIndustryStocks();
  }, [ticker]);

  const handleRowClick = (symbol: string) => {
    router.push(`/search/${symbol}`);
  };

  const sectorName = data?.industry ?? decodeURIComponent(ticker).replace(/_/g, ' ');
  const horizonLabel = data?.horizonLabel ?? '1M';
  const predHeader = `${horizonLabel} Pred`;

  const columns = [
    { key: 'symbol', label: 'Symbol' },
    { key: 'name', label: 'Company Name' },
    {
      key: 'gps_score',
      label: 'GPS',
      align: 'center' as const,
      format: (val: number | null, row: any) => {
        if (val == null) {
          return <span className="text-gray-400 text-sm">—</span>;
        }
        const score = typeof val === 'string' ? parseFloat(val) : val;
        return (
          <div className="inline-flex items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-bold border ${gpsBadgeClass(score)}`}
              title={`${getGpsLabel(score)} (${score.toFixed(1)})`}
            >
              {score.toFixed(1)}
            </span>
            {row.gps_breakdown && (
              <GpsTooltip score={score} breakdown={row.gps_breakdown} symbol={row.symbol} />
            )}
          </div>
        );
      },
    },
    {
      key: 'price',
      label: 'Price',
      align: 'right' as const,
      format: (val: number | null) => formatPrice(val),
    },
    {
      key: 'change',
      label: 'Change $',
      align: 'right' as const,
      format: (val: number | null) => (
        <span className={getChangeColor(val)}>{formatPriceChange(val)}</span>
      ),
    },
    {
      key: 'changePercent',
      label: 'Change %',
      align: 'right' as const,
      format: (val: number | null) => (
        <span className={getChangeColor(val)}>{formatPercent(val)}</span>
      ),
    },
    {
      key: 'predictedPriceHorizon',
      label: predHeader,
      align: 'right' as const,
      format: (val: number | null, row: any) => {
        if (val == null) {
          return <span className="text-gray-400 text-sm">—</span>;
        }
        const storedPct = row.predictedChangePctHorizon as number | null;
        const pct = storedPct != null
          ? storedPct
          : calculatePredictionChange(row.price ?? null, val);
        return (
          <span className="whitespace-nowrap">
            <span className="font-semibold text-gray-900">{formatPrice(val)}</span>
            {pct != null && (
              <span className={`text-xs font-semibold ml-1 ${getPredictionColor(pct)}`}>
                {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
              </span>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <button
          onClick={() => router.back()}
          className="text-green-600 hover:text-green-800 flex items-center mb-4 transition-colors"
        >
          <span className="mr-1">←</span> Back
        </button>
        <h1 className="text-3xl font-bold text-gray-900">
          {sectorName} Sector
        </h1>
        <p className="text-gray-600 mt-2">
          Top stocks in <span className="font-bold">{sectorName}</span> sorted by GPS Score
          <span className="text-gray-400 text-sm"> · {horizonLabel} horizon</span>
        </p>
      </div>

      <StockTable
        title={`${sectorName} Stocks`}
        icon="📊"
        data={data?.stocks || []}
        columns={columns}
        onRowClick={handleRowClick}
        loading={loading}
        error={error}
        emptyMessage={`No stocks found in the ${sectorName} sector.`}
      />
    </div>
  );
}
