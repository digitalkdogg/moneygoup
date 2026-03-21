
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import StockTable from '@/app/components/StockTable';
import { formatCurrency, formatNumber } from '@/utils/formatters';

interface RecommendedStock {
  id: number;
  type: string;
  ticker: string;
  symbol: string; // Map ticker to symbol for StockTable
  company_name: string;
  current_price: number;
  gps_score: number;
  classification: string; // This stores the sector
  analyst_upside_pct: number;
  revenue_growth_yoy: number;
  gross_margin_pct: number;
  rd_spend_pct: number;
  market_cap_m: number;
  mention_count: number;
  discovery_source: string;
  trading_signal?: string;
  trading_signal_score?: number;
  snapshot_date: string;
  metric_value?: number; // Stores predicted_change_pct
  metric_label?: string; // Stores confidence_score
}

interface RecommendedETF {
  id: number;
  ticker: string;
  symbol: string; // Map ticker to symbol for StockTable
  etf_name: string;
  snapshot_date: string;
  current_price: number;
  etf_gps_score: number;
  theme: string;
  aum_m: number;
  expense_ratio_pct: number;
  "52wk_return_pct": number;
  "3mo_return_pct": number;
  avg_daily_volume: number;
  momentum_score: number;
  news_signal_score: number;
  discovery_source: string;
  is_leveraged: boolean;
}

interface DeepMoneyData {
  hot_stocks: RecommendedStock[];
  hot_etfs: RecommendedETF[];
}

const stockColumns = [
  {
    key: 'symbol',
    label: 'Symbol',
    align: 'left' as const,
    format: (value: string, row: any) => (
      <div>
        <span className="font-bold text-gray-900">{value}</span>
        <p className="text-xs text-gray-500 truncate max-w-[200px]">{row.company_name}</p>
      </div>
    ),
  },
  {
    key: 'current_price',
    label: 'Price',
    align: 'right' as const,
    format: (value: any) => (
      <span className="font-semibold text-gray-800">{formatCurrency(value, 2)}</span>
    ),
  },
  {
    key: 'gps_score',
    label: 'GPS Score',
    align: 'center' as const,
    format: (value: any) => {
        const num = typeof value === 'string' ? parseFloat(value) : value;
        const color = num >= 70 ? 'text-emerald-600' : num >= 50 ? 'text-green-500' : 'text-yellow-600';
        return <span className={`font-bold ${color}`}>{formatNumber(num, 1)}/100</span>;
    }
  },
  {
    key: 'trading_signal',
    label: 'Signal',
    align: 'center' as const,
    format: (value: string, row: any) => {
      const score = row.trading_signal_score;
      const color = value === 'BUY' ? 'text-green-600' : value === 'SELL' ? 'text-red-600' : 'text-amber-600';
      return (
        <div className="flex flex-col items-center">
          <span className={`font-bold text-xs ${color}`}>{value || 'N/A'}</span>
          {score !== undefined && score !== null && (
            <span className="text-[10px] text-gray-400">Score: {score > 0 ? '+' : ''}{score}</span>
          )}
        </div>
      );
    }
  },
  {
    key: 'analyst_upside_pct',
    label: 'Upside',
    align: 'right' as const,
    format: (value: any) => {
        const num = typeof value === 'string' ? parseFloat(value) : value;
        const color = num > 0 ? 'text-green-600' : 'text-gray-500';
        return <span className={`font-medium ${color}`}>+{formatNumber(num, 1)}%</span>;
    }
  },
  {
    key: 'metric_value',
    label: 'Predicted Growth',
    align: 'right' as const,
    format: (value: any, row: any) => (
      <div className="flex flex-col items-end">
        <span className={`${value > 0 ? 'text-green-600' : 'text-red-600'} font-bold`}>
          {value > 0 ? '+' : ''}{formatNumber(value, 2)}%
        </span>
        {row.metric_label && (
          <span className="text-[10px] text-gray-400 italic">{row.metric_label}</span>
        )}
      </div>
    ),
  },
  {
    key: 'market_cap_m',
    label: 'Mkt Cap',
    align: 'right' as const,
    format: (value: any) => {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      return <span className="text-gray-700">${formatNumber(num / 1000, 1)}B</span>;
    },
  },
  {
    key: 'classification',
    label: 'Sector',
    align: 'left' as const,
    format: (value: string) => (
      <Link 
        href={`/search/industry/${value}`}
        onClick={(e) => e.stopPropagation()}
        className="text-xs px-2 py-1 bg-indigo-50 border border-indigo-100 rounded text-indigo-600 font-medium hover:bg-indigo-100 transition-colors"
      >
        {value}
      </Link>
    ),
  },
];

const etfColumns = [
  {
    key: 'symbol',
    label: 'ETF',
    align: 'left' as const,
    format: (value: string, row: any) => (
      <div>
        <span className="font-bold text-gray-900">{value}</span>
        <p className="text-xs text-gray-500 truncate max-w-[200px]">{row.etf_name}</p>
      </div>
    ),
  },
  {
    key: 'current_price',
    label: 'Price',
    align: 'right' as const,
    format: (value: any) => <span className="font-semibold text-gray-800">{formatCurrency(value, 2)}</span>,
  },
  {
    key: 'etf_gps_score',
    label: 'GPS Score',
    align: 'center' as const,
    format: (value: any) => {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      const color = num >= 70 ? 'text-emerald-600' : num >= 50 ? 'text-green-500' : 'text-yellow-600';
      return <span className={`font-bold ${color}`}>{formatNumber(num, 1)}/100</span>;
    },
  },
  {
    key: '52wk_return_pct',
    label: 'Past 52WK',
    align: 'right' as const,
    format: (value: any) => {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      const color = num >= 0 ? 'text-green-600' : 'text-rose-600';
      return <span className={`font-medium ${color}`}>{num >= 0 ? '+' : ''}{formatNumber(num, 1)}%</span>;
    },
  },
  {
    key: 'expense_ratio_pct',
    label: 'Expense',
    align: 'right' as const,
    format: (value: any) => {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      let color = 'text-gray-600';
      if (num < 0.20) color = 'text-emerald-600 font-semibold';
      else if (num >= 0.80) color = 'text-rose-600 font-semibold';
      return <span className={color}>{formatNumber(num, 2)}%</span>;
    },
  },
  {
    key: 'theme',
    label: 'Theme',
    align: 'left' as const,
    format: (value: string) => <span className="text-xs font-medium text-gray-500">{value}</span>,
  },
  {
    key: 'news_signal_score',
    label: 'News Signal',
    align: 'center' as const,
    format: (value: any) => {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      return (
        <div className="w-16 bg-gray-100 rounded-full h-1.5 overflow-hidden mx-auto">
          <div 
            className="bg-indigo-500 h-full" 
            style={{ width: `${Math.min(100, Math.max(0, num))}%` }}
          />
        </div>
      );
    },
  },
];

export default function DeepMoneyPicksSection() {
  const router = useRouter();
  const [data, setData] = useState<DeepMoneyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/deepmoney-picks');
      if (!res.ok) throw new Error('Failed to fetch DeepMoney picks');
      const json = await res.json();
      
      // Map ticker to symbol for StockTable compatibility
      const hot_stocks = (json.hot_stocks || []).map((s: any) => ({ ...s, symbol: s.ticker }));

      const hot_etfs = (json.hot_etfs || []).map((e: any) => ({ ...e, symbol: e.ticker }));

      setData({
        hot_stocks,
        hot_etfs
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading && !data) {
    return (
        <div className="flex justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        </div>
    );
  }

  return (
    <div className="space-y-6 mb-12">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-3xl font-extrabold text-gray-900 flex items-center">
            <span className="mr-3">🧠</span> DeepMoney Engine
        </h2>
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-4 py-2 bg-white border border-gray-200 rounded-xl shadow-sm text-sm text-green-700 hover:bg-gray-100 font-bold disabled:opacity-40 transition-all"
        >
          {loading ? 'Analyzing...' : '↻ Refresh Analysis'}
        </button>
      </div>

      <StockTable
        title="Top Growth Candidates"
        icon="🔥"
        data={data?.hot_stocks || []}
        columns={stockColumns}
        onRowClick={(symbol) => router.push(`/search/${symbol}`)}
        loading={loading}
        error={error}
        emptyMessage="No top growth picks available today."
      />

      <StockTable
        title="Hot ETFs Under $300"
        icon="🧺"
        data={data?.hot_etfs || []}
        columns={etfColumns}
        onRowClick={(symbol) => router.push(`/search/${symbol}`)}
        loading={loading}
        error={error}
        emptyMessage="No hot ETFs matching your criteria found today."
      />

    </div>
  );
}
