'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';

interface CacheEntry {
  key: string;
  expiresIn: number;
}

interface CacheStats {
  label: string;
  ttlMin: number;
  size: number;
  entries: CacheEntry[];
}

interface DiskTickerEntry {
  ticker: string;
  mtime: number;
  size: number;
}

interface DiskCacheStats {
  jsonCount: number;
  pklCount: number;
  totalBytes: number;
  tickers: string[];
  tickerEntries: DiskTickerEntry[];
}

interface DbPredictionEntry {
  symbol: string;
  createdAt: string;
  ageMinutes: number;
}

interface DbPredictionStats {
  modelVersion: string;
  windowHours: number;
  count: number;
  entries: DbPredictionEntry[];
}

type CacheData = Record<string, CacheStats>;

function formatExpiry(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  return `${seconds}s`;
}

function formatTtl(minutes: number): string {
  if (minutes >= 1440) return `${minutes / 1440}d`;
  if (minutes >= 60) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatAge(minutes: number): string {
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  if (minutes === 0) return 'just now';
  return `${minutes}m ago`;
}

interface TickerClearResult {
  ticker: string;
  memoryDeleted: number;
  diskDeleted: number;
  dbCleared: boolean;
}

function TickerClearCard({
  clearing, setClearing, setError, fetchStats,
}: {
  clearing: string | null;
  setClearing: (v: string | null) => void;
  setError: (v: string | null) => void;
  fetchStats: () => Promise<void>;
}) {
  const [ticker, setTicker] = useState('');
  const [result, setResult] = useState<TickerClearResult | null>(null);

  const handleClear = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setResult(null);
    setClearing(`ticker_${t}`);
    try {
      const res = await fetch(`/api/admin/cache?cache=ticker&ticker=${t}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear ticker caches');
      const data = await res.json();
      setResult({ ticker: t, memoryDeleted: data.memoryDeleted ?? 0, diskDeleted: data.diskDeleted ?? 0, dbCleared: true });
      setTicker('');
      await fetchStats();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setClearing(null);
    }
  };

  const isClearing = clearing?.startsWith('ticker_');

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span className="text-sm font-semibold text-gray-700">Clear All Caches for Ticker</span>
          <span className="text-xs text-gray-400">— memory, DB predictions, and Python disk cache</span>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <input
            type="text"
            placeholder="e.g. WMT"
            value={ticker}
            onChange={e => { setTicker(e.target.value.toUpperCase()); setResult(null); }}
            onKeyDown={e => e.key === 'Enter' && handleClear()}
            className="w-32 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-red-400 focus:border-red-400 font-mono uppercase"
          />
          <button
            onClick={handleClear}
            disabled={clearing !== null || !ticker.trim()}
            className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
          >
            {isClearing ? 'Clearing…' : 'Clear Ticker'}
          </button>
        </div>
      </div>
      {result && (
        <div className="mt-3 flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          <svg className="h-4 w-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span>
            <strong>{result.ticker}</strong> cleared —{' '}
            {result.memoryDeleted} in-memory {result.memoryDeleted === 1 ? 'entry' : 'entries'},{' '}
            {result.diskDeleted} disk {result.diskDeleted === 1 ? 'file' : 'files'},{' '}
            DB prediction record removed
          </span>
        </div>
      )}
    </div>
  );
}

export default function AdminCachePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [caches, setCaches] = useState<CacheData>({});
  const [dbPredictions, setDbPredictions] = useState<DbPredictionStats | null>(null);
  const [diskCache, setDiskCache] = useState<DiskCacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [tickerInput, setTickerInput] = useState('');
  const [diskSearch, setDiskSearch] = useState('');

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/cache');
      if (!res.ok) {
        if (res.status === 403) throw new Error('Forbidden: Admin access required');
        throw new Error('Failed to fetch cache stats');
      }
      const data = await res.json();
      setCaches(data.caches);
      setDbPredictions(data.dbPredictions ?? null);
      setDiskCache(data.diskCache ?? null);
      setLastRefreshed(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    } else if (status === 'authenticated' && (session.user as any).role !== 'admin') {
      router.push('/');
    } else if (status === 'authenticated') {
      fetchStats();
    }
  }, [status, session, router, fetchStats]);

  const handleClear = async (cacheKey: string, label?: string) => {
    const displayLabel = label ?? (cacheKey === 'all' ? 'ALL caches (memory + DB predictions)' : caches[cacheKey]?.label ?? cacheKey);
    if (!window.confirm(`Clear ${displayLabel}? This cannot be undone.`)) return;

    setClearing(cacheKey);
    try {
      const res = await fetch(`/api/admin/cache?cache=${cacheKey}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear cache');
      await fetchStats();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setClearing(null);
    }
  };

  const handleClearDbTicker = async () => {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    if (!window.confirm(`Clear DB prediction cache for ${ticker}?`)) return;

    setClearing(`db_ticker_${ticker}`);
    try {
      const res = await fetch(`/api/admin/cache?cache=db_predictions&ticker=${ticker}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear ticker prediction');
      setTickerInput('');
      await fetchStats();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setClearing(null);
    }
  };

  const totalEntries = Object.values(caches).reduce((sum, c) => sum + c.size, 0);

  if (status === 'loading' || (status === 'authenticated' && loading && Object.keys(caches).length === 0)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-2 md:p-4">
      <div className="max-w-screen-xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-4">
            <Link href="/">
              <Image src="/growmystock_logo.svg" alt="Logo" width={40} height={40} />
            </Link>
            <h1 className="text-2xl font-bold text-gray-800">Admin: Cache Management</h1>
          </div>
          <Link href="/" className="text-green-700 hover:underline font-medium">
            Back to Dashboard
          </Link>
        </div>

        {/* Admin nav */}
        <div className="flex gap-2 mb-6">
          <Link
            href="/admin/users"
            className="px-4 py-2 rounded-lg bg-white border border-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-50"
          >
            User Management
          </Link>
          <span className="px-4 py-2 rounded-lg bg-green-600 text-white font-medium text-sm">
            Cache Management
          </span>
        </div>

        {error && (
          <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded shadow-sm">
            {error}
          </div>
        )}

        {/* Toolbar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <div>
              <span className="text-2xl font-bold text-gray-800">{totalEntries}</span>
              <span className="ml-2 text-sm text-gray-500">
                in-memory entries · {dbPredictions?.count ?? 0} DB predictions · {(diskCache?.jsonCount ?? 0) + (diskCache?.pklCount ?? 0)} disk files ({formatBytes(diskCache?.totalBytes ?? 0)})
              </span>
            </div>
            {lastRefreshed && (
              <span className="text-xs text-gray-400">
                Last refreshed: {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={fetchStats}
              disabled={loading}
              className="px-4 py-2 text-sm text-green-700 border border-green-200 rounded-lg hover:bg-green-50 disabled:opacity-50"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button
              onClick={() => handleClear('all')}
              disabled={clearing !== null}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {clearing === 'all' ? 'Clearing...' : 'Clear All Caches'}
            </button>
          </div>
        </div>

        {/* Clear by ticker */}
        <TickerClearCard clearing={clearing} setClearing={setClearing} setError={setError} fetchStats={fetchStats} />

        {/* DB Predictions Cache */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-amber-50">
            <div>
              <span className="font-semibold text-gray-800 text-sm">DB Prediction Cache</span>
              <span className="ml-2 text-xs text-gray-500">
                {dbPredictions?.windowHours}h window · model: {dbPredictions?.modelVersion ?? '—'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                (dbPredictions?.count ?? 0) === 0
                  ? 'bg-gray-100 text-gray-400'
                  : 'bg-amber-100 text-amber-700'
              }`}>
                {dbPredictions?.count ?? 0} {dbPredictions?.count === 1 ? 'ticker' : 'tickers'}
              </span>
              <button
                onClick={() => handleClear('db_predictions', 'all active DB predictions')}
                disabled={clearing !== null || (dbPredictions?.count ?? 0) === 0}
                className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40 font-medium"
              >
                {clearing === 'db_predictions' ? 'Clearing...' : 'Clear All'}
              </button>
            </div>
          </div>

          <div className="p-4 border-b border-gray-100 flex items-center gap-2">
            <input
              type="text"
              placeholder="Ticker (e.g. CDP)"
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && handleClearDbTicker()}
              className="w-40 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 font-mono uppercase"
            />
            <button
              onClick={handleClearDbTicker}
              disabled={clearing !== null || !tickerInput.trim()}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {clearing?.startsWith('db_ticker_') ? 'Clearing...' : 'Clear Ticker'}
            </button>
            <span className="text-xs text-gray-400">Clears the DB cache for one ticker so the next visit runs a fresh prediction</span>
          </div>

          <div className="divide-y divide-gray-50 max-h-60 overflow-y-auto">
            {(dbPredictions?.entries.length ?? 0) === 0 ? (
              <div className="px-4 py-3 text-xs text-gray-400 italic">No active DB predictions in cache window</div>
            ) : (
              dbPredictions!.entries.map((entry) => (
                <div key={entry.symbol + entry.createdAt} className="flex items-center justify-between px-4 py-2">
                  <span className="text-xs text-gray-800 font-mono font-semibold w-20">{entry.symbol}</span>
                  <span className="text-xs text-gray-400 flex-1 ml-2">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <span className={`text-xs ml-2 whitespace-nowrap ${
                    entry.ageMinutes < 5 ? 'text-green-600' :
                    entry.ageMinutes < 60 ? 'text-gray-500' :
                    'text-amber-500'
                  }`}>
                    {formatAge(entry.ageMinutes)}
                  </span>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`Clear DB prediction cache for ${entry.symbol}?`)) return;
                      setClearing(`db_ticker_${entry.symbol}`);
                      try {
                        await fetch(`/api/admin/cache?cache=db_predictions&ticker=${entry.symbol}`, { method: 'DELETE' });
                        await fetchStats();
                      } catch { } finally { setClearing(null); }
                    }}
                    disabled={clearing !== null}
                    className="ml-4 text-xs text-red-500 hover:text-red-700 disabled:opacity-40"
                  >
                    Clear
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Python Disk Cache */}
        {(() => {
          const allEntries = diskCache?.tickerEntries ?? [];
          const query = diskSearch.trim().toUpperCase();
          const filtered = query
            ? allEntries.filter(e => e.ticker.includes(query))
            : allEntries.slice(0, 10);
          const isSearching = query.length > 0;

          const clearDiskTicker = async (ticker: string) => {
            setClearing(`disk_ticker_${ticker}`);
            try {
              await fetch(`/api/admin/cache?cache=disk_features&ticker=${ticker}`, { method: 'DELETE' });
              await fetchStats();
            } catch (err: any) { setError(err.message); } finally { setClearing(null); }
          };

          return (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-6">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-blue-50">
                <div>
                  <span className="font-semibold text-gray-800 text-sm">Python Disk Cache</span>
                  <span className="ml-2 text-xs text-gray-500">
                    scripts/prediction_cache/ · {formatBytes(diskCache?.totalBytes ?? 0)} · no TTL
                  </span>
                </div>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  (diskCache?.jsonCount ?? 0) === 0 ? 'bg-gray-100 text-gray-400' : 'bg-blue-100 text-blue-700'
                }`}>
                  {diskCache?.jsonCount ?? 0} predictions · {diskCache?.pklCount ?? 0} feature caches
                </span>
              </div>

              {/* Bulk actions */}
              <div className="px-4 py-3 flex flex-wrap gap-2 border-b border-gray-100">
                <button
                  onClick={async () => {
                    if (!window.confirm(`Delete all ${diskCache?.jsonCount} prediction JSON files from disk?`)) return;
                    setClearing('disk_predictions');
                    try {
                      await fetch('/api/admin/cache?cache=disk_predictions', { method: 'DELETE' });
                      await fetchStats();
                    } catch (err: any) { setError(err.message); } finally { setClearing(null); }
                  }}
                  disabled={clearing !== null || (diskCache?.jsonCount ?? 0) === 0}
                  className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {clearing === 'disk_predictions' ? 'Clearing...' : `Clear ${diskCache?.jsonCount ?? 0} Prediction JSONs`}
                </button>
                <button
                  onClick={async () => {
                    if (!window.confirm(`Delete all ${diskCache?.pklCount} feature PKL files from disk?`)) return;
                    setClearing('disk_features');
                    try {
                      await fetch('/api/admin/cache?cache=disk_features', { method: 'DELETE' });
                      await fetchStats();
                    } catch (err: any) { setError(err.message); } finally { setClearing(null); }
                  }}
                  disabled={clearing !== null || (diskCache?.pklCount ?? 0) === 0}
                  className="px-3 py-1.5 text-xs bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                >
                  {clearing === 'disk_features' ? 'Clearing...' : `Clear ${diskCache?.pklCount ?? 0} Feature PKLs`}
                </button>
                <button
                  onClick={async () => {
                    if (!window.confirm('Delete ALL files in prediction_cache/?')) return;
                    setClearing('disk_all');
                    try {
                      await fetch('/api/admin/cache?cache=disk_all', { method: 'DELETE' });
                      await fetchStats();
                    } catch (err: any) { setError(err.message); } finally { setClearing(null); }
                  }}
                  disabled={clearing !== null || ((diskCache?.jsonCount ?? 0) + (diskCache?.pklCount ?? 0)) === 0}
                  className="px-3 py-1.5 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50"
                >
                  {clearing === 'disk_all' ? 'Clearing...' : 'Clear Entire Disk Cache'}
                </button>
              </div>

              {/* Search */}
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                <div className="relative flex-1 max-w-xs">
                  <input
                    type="text"
                    placeholder="Search ticker…"
                    value={diskSearch}
                    onChange={e => setDiskSearch(e.target.value.toUpperCase())}
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 font-mono uppercase"
                  />
                  <svg className="absolute left-2.5 top-2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                  </svg>
                  {diskSearch && (
                    <button onClick={() => setDiskSearch('')} className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
                  )}
                </div>
                <span className="text-xs text-gray-400">
                  {isSearching
                    ? `${filtered.length} match${filtered.length !== 1 ? 'es' : ''} for "${query}"`
                    : `Showing ${Math.min(10, allEntries.length)} of ${allEntries.length} feature caches (most recent first)`}
                </span>
              </div>

              {/* Ticker rows */}
              <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                {allEntries.length === 0 ? (
                  <div className="px-4 py-4 text-xs text-gray-400 italic">No feature caches on disk</div>
                ) : filtered.length === 0 ? (
                  <div className="px-4 py-4 text-xs text-gray-400 italic">No match for "{query}"</div>
                ) : (
                  filtered.map(entry => {
                    const isClearing = clearing === `disk_ticker_${entry.ticker}`;
                    const cachedAt = new Date(entry.mtime);
                    const ageMs = Date.now() - entry.mtime;
                    const ageMin = Math.floor(ageMs / 60000);
                    return (
                      <div key={entry.ticker} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50">
                        <span className="text-xs font-mono font-semibold text-gray-800 w-20 shrink-0">{entry.ticker}</span>
                        <span className="text-xs text-gray-400 flex-1">{cachedAt.toLocaleString()}</span>
                        <span className="text-xs text-gray-400 shrink-0">{formatBytes(entry.size)}</span>
                        <span className={`text-xs shrink-0 ${ageMin < 60 ? 'text-green-600' : ageMin < 720 ? 'text-gray-400' : 'text-amber-500'}`}>
                          {formatAge(ageMin)}
                        </span>
                        <button
                          onClick={() => clearDiskTicker(entry.ticker)}
                          disabled={clearing !== null}
                          title={`Clear ${entry.ticker} feature cache`}
                          className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:bg-red-100 hover:text-red-600 disabled:opacity-40 transition-colors"
                        >
                          {isClearing ? (
                            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                            </svg>
                          ) : (
                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                          )}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })()}

        {/* In-memory cache cards grid */}
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">In-Memory Caches</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(caches).map(([key, stats]) => (
            <div key={key} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
                <div>
                  <span className="font-semibold text-gray-800 text-sm">{stats.label}</span>
                  <span className="ml-2 text-xs text-gray-400">TTL: {formatTtl(stats.ttlMin)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    stats.size === 0
                      ? 'bg-gray-100 text-gray-400'
                      : 'bg-green-100 text-green-700'
                  }`}>
                    {stats.size} {stats.size === 1 ? 'entry' : 'entries'}
                  </span>
                  <button
                    onClick={() => handleClear(key)}
                    disabled={clearing !== null || stats.size === 0}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40 font-medium"
                  >
                    {clearing === key ? 'Clearing...' : 'Clear'}
                  </button>
                </div>
              </div>

              <div className="divide-y divide-gray-50 max-h-48 overflow-y-auto">
                {stats.entries.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-gray-400 italic">Empty</div>
                ) : (
                  stats.entries.map((entry) => (
                    <div key={entry.key} className="flex items-center justify-between px-4 py-2">
                      <span className="text-xs text-gray-700 font-mono truncate max-w-[180px]" title={entry.key}>
                        {entry.key}
                      </span>
                      <span className={`text-xs ml-2 whitespace-nowrap ${
                        entry.expiresIn < 60 ? 'text-red-500' :
                        entry.expiresIn < 300 ? 'text-amber-500' :
                        'text-gray-400'
                      }`}>
                        {formatExpiry(entry.expiresIn)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
