// src/app/components/Dashboard.tsx
'use client';

import { useState, useEffect, useCallback } from 'react'; // Import useCallback
import { useRouter } from 'next/navigation';
import Link from 'next/link'; // Import Link
import PortfolioSection from './PortfolioSection'; // Updated to use StockCardSection internally
import WatchlistSection from './WatchlistSection'; // Updated to use StockCardSection internally
import PortfolioSummary from './PortfolioSummary';
import MajorIndicesStrip from './MajorIndicesStrip';
import GainsBreakdownCard from './GainsBreakdownCard';
import RecommendationsSection from './RecommendationsSection';

import { formatNumber, formatCurrency as formatUtilityCurrency } from '@/utils/formatters'; // Import formatters
import { PortfolioItem } from '@/types/portfolio'; // NEW: Import PortfolioItem
import { PortfolioTotals, AnalystRatingsResponse } from '@/types/dashboard';
import { PortfolioHistoryChart } from './PortfolioHistoryChart';
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
  const [portfolioTotals, setPortfolioTotals] = useState<PortfolioTotals | null>(null);
  const [portfolioRatings, setPortfolioRatings] = useState<AnalystRatingsResponse | null>(null);
  const [marketStatus, setMarketStatus] = useState<'open' | 'closed'>('closed');
  const [todayDate, setTodayDate] = useState<string>('');
  const [loadingPortfolio, setLoadingPortfolio] = useState(true);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const [showChart, setShowChart] = useState(false);
  
  const router = useRouter();


  // NEW: Fetch portfolio data
  const fetchPortfolioData = useCallback(async () => {
    setLoadingPortfolio(true);
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
      setPortfolioTotals(data.totals || null);
      if (data.ratings) {
        setPortfolioRatings({
          ratings: data.ratings,
          asOf: data.asOf || new Date().toISOString()
        });
      }

    } catch (err) {
      setPortfolioError(err instanceof Error ? err.message : 'An unknown error occurred while fetching portfolio');
    } finally {
      setLoadingPortfolio(false);
    }
  }, []); // Empty dependency array as it doesn't depend on any props or state from Dashboard directly

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

          {/* Portfolio Section Header */}
          <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-6 flex items-center">
            <span className="mr-3">📈</span>My Portfolio
          </h2>

          {/* Portfolio Grid */}
          <div className="mb-10">
            <PortfolioSection 
                portfolio={portfolio} 
                onRefresh={fetchPortfolioData} 
            />
          </div>

          {/* Portfolio Summary Cards */}
          <div className="mb-10">
            <PortfolioSummary 
                portfolio={portfolio} 
                marketStatus={marketStatus} 
                showChart={true}
                onToggleChart={() => {}}
            />
          </div>

          {/* Bottom Grid: History Chart and Gains Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-10 items-stretch">
            <div className="lg:col-span-2">
              <PortfolioHistoryChart />
            </div>
            <div className="lg:col-span-1">
              <GainsBreakdownCard totals={portfolioTotals} loading={loadingPortfolio} />
            </div>
          </div>

          {/* Discovery & Watchlist */}
          <div className="border-t border-gray-200 pt-10 mt-10">
            <h2 className="text-2xl font-bold text-gray-800 mb-6 flex items-center">
              <span className="mr-3">🔍</span>Discovery & Watchlist
            </h2>
            <RecommendationsSection />
            <div className="mt-10">
              <WatchlistSection onRefresh={fetchPortfolioData} />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
