// src/app/components/Dashboard.tsx
'use client';

import { useState, useEffect, useCallback } from 'react'; // Import useCallback
import { useRouter } from 'next/navigation';
import Link from 'next/link'; // Import Link
import PortfolioSection from './PortfolioSection'; // Updated to use StockCardSection internally
import WatchlistSection from './WatchlistSection'; // Updated to use StockCardSection internally
import PortfolioSummary from './PortfolioSummary'; // NEW: Import PortfolioSummary
import MarketOverviewCard from './MarketOverviewCard';
import GainsBreakdownCard from './GainsBreakdownCard';
import RecommendationsSection from './RecommendationsSection';

import { formatNumber, formatCurrency as formatUtilityCurrency } from '@/utils/formatters'; // Import formatters
import { PortfolioItem } from '@/types/portfolio'; // NEW: Import PortfolioItem
import { PortfolioTotals, AnalystRatingsResponse } from '@/types/dashboard';
import { PortfolioHistoryChart } from './PortfolioHistoryChart';

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

      // Determine market status: if any stock has a currentPrice different from prevClose, market is open
      const marketIsOpen = fetchedPortfolio.some(item =>
        item.regularMarketPrice !== null && item.prev_close !== null && item.regularMarketPrice !== item.prev_close
      );
      setMarketStatus(marketIsOpen ? 'open' : 'closed');

    } catch (err) {
      setPortfolioError(err instanceof Error ? err.message : 'An unknown error occurred while fetching portfolio');
    } finally {
      setLoadingPortfolio(false);
    }
  }, []); // Empty dependency array as it doesn't depend on any props or state from Dashboard directly

  useEffect(() => {
    fetchPortfolioData(); // Fetch portfolio data when component mounts
  }, [fetchPortfolioData]);

  // const handleRowClick = (symbol: string) => {
  //   router.push(`/search/${symbol}`);
  // };

  // The modal logic has been moved to PortfolioSection and WatchlistSection

  if (loadingPortfolio) { // Use loadingPortfolio for overall loading
    return (
      <div className="text-center p-10">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <p className="mt-4 text-lg text-gray-600">Loading Dashboard...</p>
      </div>
    );
  }

  if (portfolioError) { // Use portfolioError for overall error
    return (
      <div className="bg-red-100 border-2 border-red-400 text-red-700 px-6 py-4 rounded-xl text-center shadow-lg font-semibold m-4">
        Error: {portfolioError}.<br/>
        Please ensure the database is running and accessible.
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <div className="max-w-screen-2xl mx-auto">
          <header className="text-center mb-12">
            <h1 className="text-4xl font-bold text-gray-800 mb-4">Stock Dashboard</h1>
            <p className="text-lg text-gray-600">Tracked stocks and their latest data.</p>
          </header>

          {/* NEW: Portfolio Summary */}
          <PortfolioSummary 
            portfolio={portfolio} 
            marketStatus={marketStatus} 
            showChart={showChart}
            onToggleChart={() => setShowChart(!showChart)}
          />

          {showChart && <PortfolioHistoryChart />}

          {/* New Dashboard Widgets Row */}
           {/* Analyst Ratings Row */}
          <div className="mb-6">

          </div>

          {/* Market Overview + Gains Breakdown Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
            <MarketOverviewCard />
            <GainsBreakdownCard totals={portfolioTotals} loading={loadingPortfolio} />
          </div>

          {/* Portfolio and Watchlist Sections */}
          <PortfolioSection portfolio={portfolio} onRefresh={fetchPortfolioData} />
          
          {/* Recommendations Section */}
          <RecommendationsSection />
          
          <WatchlistSection onRefresh={() => {
            // Optional: refresh other data if needed
          }} />
        </div>
      </div>

      {/* Modals have been removed from here and are now handled within PortfolioSection and WatchlistSection */}
    </>
  );
}
