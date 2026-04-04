'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import StockTable from './StockTable';
import { formatCurrency, formatNumber } from '@/utils/formatters';

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
  heatScore: number;
  volumeRatio: number;
  fiftyTwoWeekPosition: number;
}

export default function IndustryStocks({ ticker }: IndustryStocksProps) {
  const router = useRouter();
  const [data, setData] = useState<{ industry: string; stocks: IndustryStock[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchIndustryStocks() {
      try {
        setLoading(true);
        setError(null);
        // Correct API path
        const response = await fetch(`/api/stock_data/${ticker}/industry`);
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || 'Failed to fetch industry stocks');
        }

        const json = await response.json();
        setData(json);
      } catch (err) {
        console.error('Error fetching industry stocks:', err);
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    }

    if (ticker) {
      fetchIndustryStocks();
    }
  }, [ticker]);

  const handleRowClick = (symbol: string) => {
    router.push(`/search/${symbol}`);
  };

  const columns = [
    { key: 'symbol', label: 'Symbol' },
    { key: 'name', label: 'Company Name' },
    { 
      key: 'heatScore', 
      label: 'Heat 🔥', 
      align: 'center' as const,
      format: (val: number) => {
        const colorClass = 
          val >= 80 ? 'bg-red-100 text-red-800 border-red-200' :
          val >= 60 ? 'bg-orange-100 text-orange-800 border-orange-200' :
          val >= 40 ? 'bg-yellow-100 text-yellow-800 border-yellow-200' :
          'bg-gray-100 text-gray-800 border-gray-200';
        return (
          <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${colorClass}`}>
            {val}
          </span>
        );
      }
    },
    { 
      key: 'price', 
      label: 'Price', 
      align: 'right' as const,
      format: (val: number) => formatCurrency(val)
    },
    { 
      key: 'changePercent', 
      label: 'Change %', 
      align: 'right' as const,
      format: (val: number) => (
        <span className={val >= 0 ? 'text-green-600' : 'text-red-600'}>
          {val >= 0 ? '+' : ''}{val.toFixed(2)}%
        </span>
      )
    },
    {
      key: 'volumeRatio',
      label: 'Vol Ratio',
      align: 'right' as const,
      format: (val: number) => <span className="font-medium text-indigo-600">{val.toFixed(1)}x</span>
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
      }
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
          ></div>
        </div>
      )
    }
  ];

  const decodedTicker = decodeURIComponent(ticker).replace(/_/g, ' ');
  const isTicker = decodedTicker.length <= 5 && !decodedTicker.includes(' ');

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
          {data ? `${data.industry} Industry` : 'Industry Search'}
        </h1>
        <p className="text-gray-600 mt-2">
          {isTicker 
            ? `Top active stocks in the same industry as ` 
            : `Top active stocks in the `}
          <span className="font-bold">{decodedTicker}</span>
          {!isTicker && ` industry`}
        </p>
      </div>

      <StockTable
        title={data ? `${data.industry} Stocks` : 'Industry Stocks'}
        icon="📊"
        data={data?.stocks || []}
        columns={columns}
        onRowClick={handleRowClick}
        loading={loading}
        error={error}
        emptyMessage={`No other stocks found in the ${data?.industry || 'same'} industry.`}
      />
    </div>
  );
}
