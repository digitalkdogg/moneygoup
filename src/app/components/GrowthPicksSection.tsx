'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { GrowthPickStock } from '@/app/api/dashboard/growth-picks/route';
import StockTable from '@/app/components/StockTable';

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt$(v: number | undefined, decimals = 2): string {
  if (v === undefined || v === null || isNaN(v)) return 'N/A';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtPct(v: number | undefined, decimals = 1): string {
  if (v === undefined || v === null || isNaN(v)) return 'N/A';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(decimals)}%`;
}

function fmtMCap(v: number | undefined): string {
  if (!v) return 'N/A';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function scoreColor(score: number): string {
  if (score >= 75) return '#059669'; // emerald-600
  if (score >= 55) return '#22c55e'; // green-500
  if (score >= 40) return '#eab308'; // yellow-500
  return '#9ca3af';                  // gray-400
}

// ─── column definitions ───────────────────────────────────────────────────────

const columns = [
  {
    key: 'rank',
    label: '#',
    align: 'center' as const,
    format: (value: number) => (
      <span className="text-xs font-bold text-gray-400">#{value}</span>
    ),
  },
  {
    key: 'symbol',
    label: 'Symbol',
    align: 'left' as const,
    format: (value: string, row: any) => (
      <div>
        <span className="font-semibold text-gray-900">{value}</span>
        {row.sector && (
          <span className="ml-2 text-xs px-2 py-0.5 bg-gray-100 border border-gray-200 rounded-full text-gray-500">
            {row.sector}
          </span>
        )}
        <p className="text-xs text-gray-400 truncate max-w-[180px]">{row.name}</p>
      </div>
    ),
  },
  {
    key: 'regularMarketPrice',
    label: 'Price',
    align: 'right' as const,
    format: (value: number) => (
      <span className="font-semibold text-gray-800">{fmt$(value)}</span>
    ),
  },
  {
    key: 'momentum6m',
    label: '6M Return',
    align: 'right' as const,
    format: (value: number | undefined) => {
      const pct = fmtPct(value);
      const color = value === undefined ? 'text-gray-500' : value > 0 ? 'text-green-600' : 'text-red-500';
      return <span className={`font-medium ${color}`}>{pct}</span>;
    },
  },
  {
    key: 'revenueGrowth',
    label: 'Rev Growth',
    align: 'right' as const,
    format: (value: number | undefined) => {
      const pct = fmtPct(value);
      const color = value === undefined ? 'text-gray-500' : value > 0 ? 'text-green-600' : 'text-red-500';
      return <span className={`font-medium ${color}`}>{pct}</span>;
    },
  },
  {
    key: 'trailingPE',
    label: 'P/E',
    align: 'right' as const,
    format: (value: number | undefined) => (
      <span className="text-gray-700">{value && value > 0 ? value.toFixed(1) : 'N/A'}</span>
    ),
  },
  {
    key: 'marketCap',
    label: 'Mkt Cap',
    align: 'right' as const,
    format: (value: number | undefined) => (
      <span className="text-gray-700">{fmtMCap(value)}</span>
    ),
  },
  {
    key: 'scoreBreakdown',
    label: 'Score',
    align: 'center' as const,
    format: (value: GrowthPickStock['scoreBreakdown']) => (
      <span
        className="font-bold text-sm"
        style={{ color: scoreColor(value.totalScore) }}
      >
        {value.totalScore}/100
      </span>
    ),
  },
  {
    key: 'growthThesis',
    label: 'Thesis',
    align: 'left' as const,
    format: (value: string) => (
      <span className="text-xs text-gray-500 italic">💡 {value}</span>
    ),
  },
];

// ─── main component ───────────────────────────────────────────────────────────

export default function GrowthPicksSection() {
  const router = useRouter();
  const [picks, setPicks] = useState<GrowthPickStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPicks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/growth-picks');
      if (!res.ok) throw new Error('Failed to fetch growth picks');
      const data: GrowthPickStock[] = await res.json();
      setPicks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPicks(); }, [fetchPicks]);

  // Attach rank to each row so the rank column formatter can access it
  const tableData = picks.map((pick, idx) => ({
    ...pick,
    rank: idx + 1,
  }));

  return (
    <div>
      <div className="flex justify-end px-1 mb-2">
        <button
          onClick={fetchPicks}
          disabled={loading}
          className="text-sm text-green-700 hover:text-green-800 font-semibold disabled:opacity-40 transition-colors"
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      <StockTable
        title="Growth Picks Under $200"
        icon="🌱"
        data={tableData}
        columns={columns}
        onRowClick={(symbol) => router.push(`/search/${symbol}`)}
        loading={loading}
        error={error}
        emptyMessage="No qualifying picks found right now. Try refreshing in a moment."
      />

      {!loading && picks.length > 0 && (
        <p className="text-xs text-gray-400 text-center -mt-6 mb-8">
          ⚠️ Not financial advice. Scores are algorithmic and based on recent data. Always do your own research before investing.
        </p>
      )}
    </div>
  );
}