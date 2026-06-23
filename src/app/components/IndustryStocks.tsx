'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import StockTable from './StockTable';
import { GpsTooltip } from './cards/GpsTooltip';
import { formatCurrency } from '@/utils/formatters';
import { getGpsLabel } from '@/utils/gps';

interface IndustryStocksProps {
  ticker: string;
}

interface IndustryStock {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  marketCap: number;
  volume: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  fiftyTwoWeekPosition: number;
  gps_score: number | null;
  gps_breakdown: any | null;
  gps_as_of: string | null;
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
      format: (val: number) => formatCurrency(val),
    },
    {
      key: 'changePercent',
      label: 'Change %',
      align: 'right' as const,
      format: (val: number) => (
        <span className={val >= 0 ? 'text-green-600' : 'text-red-600'}>
          {val >= 0 ? '+' : ''}{val.toFixed(2)}%
        </span>
      ),
    },
    {
      key: 'marketCap',
      label: 'Market Cap',
      align: 'right' as const,
      format: (val: number) => {
        if (!val) return 'N/A';
        if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
        if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
        if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
        return formatCurrency(val);
      },
    },
    {
      key: 'fiftyTwoWeekPosition',
      label: '52W Range',
      align: 'center' as const,
      format: (val: number) => (
        <div className="w-24 bg-gray-200 rounded-full h-1.5 mx-auto">
          <div
            className="bg-blue-600 h-1.5 rounded-full"
            style={{ width: `${Math.min(100, Math.max(0, val))}%` }}
          />
        </div>
      ),
    },
  ];

  const sectorName = data?.industry ?? decodeURIComponent(ticker).replace(/_/g, ' ');
  const horizonLabel = data?.horizonLabel ?? '1-month baseline';

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
          <span className="text-gray-400 text-sm"> · {horizonLabel}</span>
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
