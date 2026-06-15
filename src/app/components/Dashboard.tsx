// src/app/components/Dashboard.tsx
'use client';

import { useState, useEffect, useCallback } from 'react'; // Import useCallback
import { useRouter } from 'next/navigation';
import Link from 'next/link'; // Import Link
import PortfolioSection from './PortfolioSection'; // Updated to use StockCardSection internally
import WatchlistSection from './WatchlistSection'; // Updated to use StockCardSection internally
import PortfolioSummary from './PortfolioSummary';
import MajorIndicesStrip from './MajorIndicesStrip';
import RecommendationsSection from './RecommendationsSection';
import ModelAccuracyWidget from './ModelAccuracyWidget';

import { formatNumber, formatCurrency as formatUtilityCurrency } from '@/utils/formatters'; // Import formatters
import { PortfolioItem } from '@/types/portfolio'; // NEW: Import PortfolioItem
import { getMarketStatus } from '@/utils/marketStatus';

interface StockData {
  symbol?: string
  name?: string
  last?: number
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  prevClose?: number
  timestamp?: string
  exchange?: string
  error?: string
  peRatio?: number
  pbRatio?: number
  marketCap?: number
}

interface HistoricalData {
  date: string
  datetime: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  adjOpen: number
  adjHigh: number
  adjLow: number
  adjClose: number
  adjVolume: number
}


interface StockDashboardData {
  stock_id: number;
  symbol: string;
  companyName: string;
  isOwned: boolean;
  shares?: number;
  purchase_price?: number;
  estimatedDailyEarnings?: number;
  lifetimeEarnings?: number;
}


interface RecommendedStock {
  symbol: string;
  name: string | undefined;
  regularMarketPrice: number;
  marketCap: number | undefined;
  metric?: string | number;
  metricLabel?: string;
}

// Define the type for a column definition for StockTable (copied from PortfolioSection.tsx to avoid circular dependency for now)
type ColumnDefinition<T> = {
  key: keyof T | string;
  label: string;
  align?: 'left' | 'center' | 'right';
  format?: (value: any, row: T) => React.ReactNode;
};


export default function Dashboard() {
  // NEW: Portfolio state and market status
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [portfolioHorizonLabel, setPortfolioHorizonLabel] = useState<string>('1M');
  const [marketStatus, setMarketStatus] = useState<'open' | 'closed'>('closed');
  const [todayDate, setTodayDate] = useState<string>('');
  const [loadingPortfolio, setLoadingPortfolio] = useState(true);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const router = useRouter();


  // NEW: Fetch portfolio data. `silent` skips the loading spinner so background
  // refreshes (e.g. brand-color polling after a purchase) don't unmount children.
  const fetchPortfolioData = useCallback(async (opts?: { silent?: boolean }): Promise<PortfolioItem[] | null> => {
    if (!opts?.silent) setLoadingPortfolio(true);
    setPortfolioError(null);
    try {
      const res = await fetch(`/api/user/portfolio?_=${new Date().getTime()}`);
      if (!res.ok) {
        throw new Error('Failed to fetch portfolio data');
      }
      const data = await res.json();
      const fetchedPortfolio: PortfolioItem[] = data.portfolio.map((item: any) => ({
        ...item,
        name: item.company_name, // Map company_name to name for StockTableRow compatibility
        shares: typeof item.shares === 'string' ? parseFloat(item.shares) : item.shares,
        regularMarketPrice: typeof item.regularMarketPrice === 'number' ? item.regularMarketPrice : 0,
        prev_close: typeof item.prev_close === 'number' ? item.prev_close : null,
      }));
      setPortfolio(fetchedPortfolio);
      if (typeof data?.horizonLabel === 'string') {
        setPortfolioHorizonLabel(data.horizonLabel);
      }
      return fetchedPortfolio;
    } catch (err) {
      setPortfolioError(err instanceof Error ? err.message : 'An unknown error occurred while fetching portfolio');
      return null;
    } finally {
      if (!opts?.silent) setLoadingPortfolio(false);
    }
  }, []); // Empty dependency array as it doesn't depend on any props or state from Dashboard directly

  // After a purchase, the brand-color script runs in the background on the
  // server. Poll silently until brand_color is present for the new stock,
  // then stop. Runs from Dashboard so it survives WatchlistSection remounts.
  const pollForBrandUpdate = useCallback(async (stockId: number) => {
    const maxAttempts = 8;
    const delayMs = 2000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, delayMs));
      const fresh = await fetchPortfolioData({ silent: true });
      if (!fresh) continue;
      const stock = fresh.find(p => p.stock_id === stockId);
      if (stock?.brand_color) return;
    }
  }, [fetchPortfolioData]);

  useEffect(() => {
    fetchPortfolioData(); // Fetch portfolio data when component mounts
    
    // Update market status and date
    const status = getMarketStatus();
    setMarketStatus(status.isOpen ? 'open' : 'closed');
    
    const now = new Date();
    setTodayDate(new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(now));
  }, [fetchPortfolioData]);

  // const handleRowClick = (symbol: string) => {
  //   router.push(`/search/${symbol}`);
  // };

  // The modal logic has been moved to PortfolioSection and WatchlistSection

  if (loadingPortfolio) { // Use loadingPortfolio for overall loading
    return (
      <div className="text-center p-10" aria-live="polite" aria-busy="true">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <p className="mt-4 text-lg text-gray-600">Loading Dashboard...</p>
      </div>
    );
  }

  if (portfolioError) { // Use portfolioError for overall error
    return (
      <div className="bg-red-100 border-2 border-red-400 text-red-700 px-6 py-4 rounded-xl text-center shadow-lg font-semibold m-4" role="alert">
        Error: {portfolioError}.<br/>
        Please ensure the database is running and accessible.
      </div>
    );
  }

  return (
    <main id="main-content">
      <div className="min-h-screen bg-[#f8f9fa] p-4 md:p-8">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row md:justify-between md:items-start mb-6">
            <div className="mb-4 md:mb-10">
              <h1>Portfolio Dashboard</h1>
              <p className="text-gray-700">Track your investments, performance and opportunities all in one place</p>
            </div>
            <div className="flex flex-row space-x-3 items-center mb-10 md:mb-0">
              <div className="market-status bg-white border border-gray-200 rounded-full px-4 py-1.5 text-sm font-semibold text-gray-700 shadow-sm flex items-center">
                <span className={`w-2 h-2 rounded-full mr-2 ${marketStatus === 'open' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                Market {marketStatus === 'open' ? 'Open' : 'Closed'}
              </div>
              <div className="today-date bg-white border border-gray-200 rounded-full px-4 py-1.5 text-sm font-semibold text-gray-700 shadow-sm flex items-center">
                {todayDate}
              </div>
            </div>
          </div>
          {/* Market Overview Row */}
          <div className="mb-10">
            <MajorIndicesStrip />
          </div>

          {/* Portfolio Section — hidden until loaded and only shown when user has stocks */}
          {!loadingPortfolio && portfolio.length > 0 && (
            <>
              <h2 className="section-heading">My Portfolio</h2>

              <div className="mb-6">
                <PortfolioSummary
                    portfolio={portfolio}
                    marketStatus={marketStatus}
                    showChart={true}
                    onToggleChart={() => {}}
                />
              </div>

              <div className="mb-10">
                <PortfolioSection
                    portfolio={portfolio}
                    horizonLabel={portfolioHorizonLabel}
                    onRefresh={fetchPortfolioData}
                />
              </div>
            </>
          )}

          {/* Discovery & Watchlist */}
          <div className="border-t border-gray-200 pt-10 mt-10">
            <h2 className="section-heading">Discovery & Watchlist</h2>
            <RecommendationsSection />
            <div className="mt-10 mb-10">
              <ModelAccuracyWidget />
            </div>
            <div className="mt-10">
              <WatchlistSection onRefresh={fetchPortfolioData} onPurchased={pollForBrandUpdate} />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
