// src/app/components/Dashboard.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link'; // Import Link
import StockTable, { StockTableRow } from '../components/StockTable';
import WatchlistSection from './WatchlistSection';
import PortfolioSection from './PortfolioSection';


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

interface SummaryData {
  totalDailyEarnings: number;
  totalLifetimeEarnings: number;
  totalDailyChange: number;
}

interface UndervaluedLargeCap {
  symbol: string;
  name: string;
  regularMarketPrice: number;
  marketCap: number;
  trailingPE?: number;
  priceToBook?: number;
}

interface RecommendedStock {
  symbol: string;
  name: string | undefined;
  regularMarketPrice: number;
  marketCap: number | undefined;
  metric?: string | number;
  metricLabel?: string;
}

const EarningsSummary = ({ summary }: { summary: SummaryData | null }) => {
  if (!summary) {
    return null;
  }

  const formatCurrency = (value: number) => {
    const sign = value > 0 ? '+' : '';
    const colorClass = value > 0 ? 'text-green-600' : value < 0 ? 'text-red-600' : 'text-gray-600';
    return <span className={colorClass}>{sign}${value.toFixed(2)}</span>;
  };

  return (
    <div className="bg-white p-6 rounded-2xl shadow-lg mb-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-4">Earnings Summary</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-center">
        <div className="p-4 bg-gray-50 rounded-lg">
          <p className="text-sm font-medium text-gray-500">Total Daily Change</p>
          <p className="text-2xl font-semibold">{formatCurrency(summary.totalDailyChange)}</p>
        </div>
        <div className="p-4 bg-gray-50 rounded-lg">
          <p className="text-sm font-medium text-gray-500">Total Daily Earnings</p>
          <p className="text-2xl font-semibold">{formatCurrency(summary.totalDailyEarnings)}</p>
        </div>
        <div className="p-4 bg-gray-50 rounded-lg">
          <p className="text-sm font-medium text-gray-500">Total Lifetime</p>
          <p className="text-2xl font-semibold">{formatCurrency(summary.totalLifetimeEarnings)}</p>
        </div>
      </div>
    </div>
  );
};


export default function Dashboard() {
  const [stocks, setStocks] = useState<StockDashboardData[]>([]);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [undervaluedLargeCaps, setUndervaluedLargeCaps] = useState<UndervaluedLargeCap[]>([]); // New state for undervalued large caps
  const [undervaluedLargeCapsError, setUndervaluedLargeCapsError] = useState<string | null>(null);
  
  // State for technical/sentiment recommendations
  const [momentumPlays, setMomentumPlays] = useState<RecommendedStock[]>([]);
  const [breakoutCandidates, setBreakoutCandidates] = useState<RecommendedStock[]>([]);
  const [analystFavorites, setAnalystFavorites] = useState<RecommendedStock[]>([]);
  const [insiderActivity, setInsiderActivity] = useState<RecommendedStock[]>([]);
  const [recommendedStocksError, setRecommendedStocksError] = useState<string | null>(null);
  const [recommendedStocksLoading, setRecommendedStocksLoading] = useState(false);
  
  const router = useRouter();

  // State for the purchase modal
  const [isPurchaseModalOpen, setIsPurchaseModalOpen] = useState(false);
  const [selectedStockForPurchase, setSelectedStockForPurchase] = useState<StockDashboardData | null>(null);
  const [purchasePrice, setPurchasePrice] = useState('');
  const [shares, setShares] = useState('');
  const [isSubmittingPurchase, setIsSubmittingPurchase] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);

  // State for the sell modal
  const [isSellModalOpen, setIsSellModalOpen] = useState(false);
  const [selectedStockForSell, setSelectedStockForSell] = useState<StockDashboardData | null>(null);
  const [isSubmittingSell, setIsSubmittingSell] = useState(false);
  const [sellError, setSellError] = useState<string | null>(null);
  const [sellSuccess, setSellSuccess] = useState<string | null>(null);

  // State for the remove modal
  const [isRemoveModalOpen, setIsRemoveModalOpen] = useState(false);
  const [selectedStockForRemove, setSelectedStockForRemove] = useState<StockDashboardData | null>(null);
  const [isSubmittingRemove, setIsSubmittingRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeSuccess, setRemoveSuccess] = useState<string | null>(null);



  
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard?_=${new Date().getTime()}`);
      if (!res.ok) {
        throw new Error('Failed to fetch data');
      }
      const { stocks: initialStocks, summary } = await res.json();
      setStocks(initialStocks);
      setSummary(summary);
  
      
  
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  const fetchUndervaluedLargeCaps = async () => {
    setUndervaluedLargeCapsError(null);
    try {
      const res = await fetch('/api/dashboard/undervalued-large-caps');
      if (!res.ok) {
        throw new Error('Failed to fetch undervalued large caps');
      }
      const data = await res.json();
      setUndervaluedLargeCaps(data);
    } catch (err) {
      setUndervaluedLargeCapsError(err instanceof Error ? err.message : 'An unknown error occurred while fetching undervalued large caps');
    }
  };

  const fetchRecommendedStocks = async () => {
    setRecommendedStocksLoading(true);
    setRecommendedStocksError(null);
    try {
      const res = await fetch('/api/dashboard/recommended-stocks');
      if (!res.ok) {
        throw new Error('Failed to fetch recommended stocks');
      }
      const data = await res.json();
      setMomentumPlays(data.momentumPlays || []);
      setBreakoutCandidates(data.breakoutCandidates || []);
      setAnalystFavorites(data.analystFavorites || []);
      setInsiderActivity(data.insiderActivity || []);
    } catch (err) {
      setRecommendedStocksError(err instanceof Error ? err.message : 'An unknown error occurred while fetching recommended stocks');
    } finally {
      setRecommendedStocksLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    fetchUndervaluedLargeCaps(); // Fetch undervalued large caps when component mounts
    fetchRecommendedStocks(); // Fetch technical/sentiment recommendations when component mounts
  }, []);

  const handleRowClick = (symbol: string) => {
    router.push(`/search/${symbol}`);
  };

  const handlePurchaseClick = (e: React.MouseEvent, stock: StockDashboardData) => {
    e.stopPropagation(); // Prevent row click from firing
    setSelectedStockForPurchase(stock);
    setIsPurchaseModalOpen(true);
    setPurchaseError(null);
    setPurchaseSuccess(null);
    setPurchasePrice(''); // No longer pre-fill with current price
    setShares('');
  };

  const handleClosePurchaseModal = () => {
    setIsPurchaseModalOpen(false);
    setSelectedStockForPurchase(null);
    setPurchasePrice('');
    setShares('');
    setPurchaseError(null);
    setPurchaseSuccess(null);
  };

  const handlePurchaseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStockForPurchase) return;

    setIsSubmittingPurchase(true);
    setPurchaseError(null);
    setPurchaseSuccess(null);

    try {
      const response = await fetch('/api/user/stocks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          stock_id: selectedStockForPurchase.stock_id,
          shares: parseFloat(shares),
          purchase_price: parseFloat(purchasePrice),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to complete purchase.');
      }

      setPurchaseSuccess(`Successfully purchased ${shares} shares of ${selectedStockForPurchase.symbol}.`);
      fetchData(); // Refresh dashboard data
      setTimeout(() => {
        handleClosePurchaseModal();
      }, 2000);

    } catch (err) {
      setPurchaseError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setIsSubmittingPurchase(false);
    }
  };


  const handleSellClick = (e: React.MouseEvent, stock: StockDashboardData) => {
    e.stopPropagation(); // Prevent row click from firing
    setSelectedStockForSell(stock);
    setIsSellModalOpen(true);
    setSellError(null);
    setSellSuccess(null);
  };

  const handleCloseSellModal = () => {
    setIsSellModalOpen(false);
    setSelectedStockForSell(null);
    setSellError(null);
    setSellSuccess(null);
  };

  const handleConfirmSell = async () => {
    if (!selectedStockForSell) return;

    setIsSubmittingSell(true);
    setSellError(null);
    setSellSuccess(null);

    try {
      const response = await fetch(`/api/user/stocks/${selectedStockForSell.stock_id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to sell stock.');
      }

      setSellSuccess(`Successfully sold all shares of ${selectedStockForSell.symbol}.`);
      fetchData(); // Refresh dashboard data
      setTimeout(() => {
        handleCloseSellModal();
      }, 2000);

    } catch (err) {
      setSellError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setIsSubmittingSell(false);
    }
  };

  const handleCloseRemoveModal = () => {
    setIsRemoveModalOpen(false);
    setSelectedStockForRemove(null);
    setRemoveError(null);
    setRemoveSuccess(null);
  };

  const handleConfirmRemove = async () => {
    if (!selectedStockForRemove) return;

    setIsSubmittingRemove(true);
    setRemoveError(null);
    setRemoveSuccess(null);

    try {
      const response = await fetch(`/api/user/watchlist?stockId=${selectedStockForRemove.symbol}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to remove stock.');
      }

      setRemoveSuccess(`Successfully removed ${selectedStockForRemove.symbol}.`);
      fetchData(); // Refresh dashboard data
      setTimeout(() => {
        handleCloseRemoveModal();
      }, 2000);

    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setIsSubmittingRemove(false);
    }
  };

  const handleRemoveStock = (e: React.MouseEvent, stock: StockDashboardData) => {
    e.stopPropagation(); // Prevent row click from firing
    setSelectedStockForRemove(stock);
    setIsRemoveModalOpen(true);
    setRemoveError(null);
    setRemoveSuccess(null);
  };






  if (loading) {
    return (
      <div className="text-center p-10">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <p className="mt-4 text-lg text-gray-600">Loading Dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border-2 border-red-400 text-red-700 px-6 py-4 rounded-xl text-center shadow-lg font-semibold m-4">
        Error: {error}.<br/>
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

          <EarningsSummary summary={summary} />

          {/* Portfolio and Watchlist Sections */}
          <PortfolioSection onRefresh={() => {
            // Optional: refresh other data if needed
          }} />
          
          <WatchlistSection onRefresh={() => {
            // Optional: refresh other data if needed
          }} />

          {/* Undervalued Large Caps Section */}
          <StockTable<UndervaluedLargeCap>
            title="Undervalued Large Caps"
            icon="💰"
            data={undervaluedLargeCaps}
            columns={[
              { key: 'symbol', label: 'Symbol' },
              { key: 'name', label: 'Company Name' },
              {
                key: 'regularMarketPrice',
                label: 'Price',
                align: 'right',
                format: (value: number) => `$${value.toFixed(2)}`,
              },
              {
                key: 'marketCap',
                label: 'Market Cap',
                align: 'right',
                format: (value: number) => `$${(value / 1e9).toFixed(2)}B`,
              },
              {
                key: 'trailingPE',
                label: 'P/E',
                align: 'right',
                format: (value: number) => value?.toFixed(2) || 'N/A',
              },
              {
                key: 'priceToBook',
                label: 'P/B',
                align: 'right',
                format: (value: number) => value?.toFixed(2) || 'N/A',
              },
            ]}
            onRowClick={handleRowClick}
            loading={false}
            error={undervaluedLargeCapsError}
            emptyMessage="No undervalued large caps data available."
          />

          {/* Momentum Plays Section */}
          <StockTable<RecommendedStock>
            title="Momentum Plays"
            icon="🚀"
            data={momentumPlays}
            columns={[
              { key: 'symbol', label: 'Symbol' },
              { key: 'name', label: 'Company Name' },
              {
                key: 'regularMarketPrice',
                label: 'Price',
                align: 'right',
                format: (value: number) => `$${value.toFixed(2)}`,
              },
              {
                key: 'metric',
                label: momentumPlays[0]?.metricLabel || 'Metric',
                align: 'right',
                format: (value: number) => `+${Number(value).toFixed(2)}%`,
              },
            ]}
            onRowClick={handleRowClick}
            loading={recommendedStocksLoading && momentumPlays.length === 0}
            error={recommendedStocksError && momentumPlays.length === 0 ? recommendedStocksError : null}
            emptyMessage="No momentum stocks found."
          />
          
          {/* Breakout Candidates Section */}
          <StockTable<RecommendedStock>
            title="Breakout Candidates"
            icon="📈"
            data={breakoutCandidates}
            columns={[
              { key: 'symbol', label: 'Symbol' },
              { key: 'name', label: 'Company Name' },
              {
                key: 'regularMarketPrice',
                label: 'Price',
                align: 'right',
                format: (value: number) => `$${value.toFixed(2)}`,
              },
              {
                key: 'metric',
                label: breakoutCandidates[0]?.metricLabel || 'Metric',
                align: 'right',
                format: (value: number) => `${Number(value).toFixed(2)}%`,
              },
            ]}
            onRowClick={handleRowClick}
            loading={recommendedStocksLoading && breakoutCandidates.length === 0}
            error={recommendedStocksError && breakoutCandidates.length === 0 ? recommendedStocksError : null}
            emptyMessage="No breakout candidates found."
          />
                    
          {/* Insider Activity Section */}
          <StockTable<RecommendedStock>
            title="Insider Activity"
            icon="💼"
            data={insiderActivity}
            columns={[
              { key: 'symbol', label: 'Symbol' },
              { key: 'name', label: 'Company Name' },
              {
                key: 'regularMarketPrice',
                label: 'Price',
                align: 'right',
                format: (value: number) => `$${value.toFixed(2)}`,
              },
              {
                key: 'metric',
                label: insiderActivity[0]?.metricLabel || 'Metric',
                align: 'right',
                format: (value: number) => `${Number(value).toFixed(1)}%`,
              },
            ]}
            onRowClick={handleRowClick}
            loading={recommendedStocksLoading && insiderActivity.length === 0}
            error={recommendedStocksError && insiderActivity.length === 0 ? recommendedStocksError : null}
            emptyMessage="No insider activity found."
          />
                    
          {/* Analyst Favorites Section */}
          <StockTable<RecommendedStock>
            title="Analyst Favorites"
            icon="👨‍💼"
            data={analystFavorites}
            columns={[
              { key: 'symbol', label: 'Symbol' },
              { key: 'name', label: 'Company Name' },
              {
                key: 'regularMarketPrice',
                label: 'Price',
                align: 'right',
                format: (value: number) => `$${value.toFixed(2)}`,
              },
              {
                key: 'metric',
                label: analystFavorites[0]?.metricLabel || 'Metric',
                align: 'right',
                format: (value: number) => Number(value).toFixed(1),
              },
            ]}
            onRowClick={handleRowClick}
            loading={recommendedStocksLoading && analystFavorites.length === 0}
            error={recommendedStocksError && analystFavorites.length === 0 ? recommendedStocksError : null}
            emptyMessage="No analyst favorites found."
          />
        </div>
      </div>

      {/* Purchase Modal */}
      {isPurchaseModalOpen && selectedStockForPurchase && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md m-4">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Purchase {selectedStockForPurchase.symbol}</h2>
            <p className="text-gray-600 mb-6">{selectedStockForPurchase.companyName}</p>
            
            <form onSubmit={handlePurchaseSubmit}>
              <div className="mb-4">
                <label htmlFor="shares" className="block text-sm font-medium text-gray-700 mb-1">Number of Shares</label>
                <input
                  type="number"
                  id="shares"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600"
                  placeholder="e.g., 10"
                  required
                  step="any"
                />
              </div>

              <div className="mb-6">
                <label htmlFor="purchasePrice" className="block text-sm font-medium text-gray-700 mb-1">Purchase Price per Share</label>
                <input
                  type="number"
                  id="purchasePrice"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600"
                  placeholder="e.g., 150.00"
                  required
                  step="any"
                />
              </div>
              
              {purchaseError && <p className="text-red-500 text-sm mb-4">{purchaseError}</p>}
              {purchaseSuccess && <p className="text-green-500 text-sm mb-4">{purchaseSuccess}</p>}

              <div className="flex justify-end space-x-4">
                <button
                  type="button"
                  onClick={handleClosePurchaseModal}
                  className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors cursor-pointer"
                  disabled={isSubmittingPurchase}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-6 py-2 text-white bg-green-700 rounded-lg hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600 disabled:bg-gray-400 transition-colors cursor-pointer"
                  disabled={isSubmittingPurchase || !shares || !purchasePrice}
                >
                  {isSubmittingPurchase ? 'Purchasing...' : 'Confirm Purchase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sell Confirmation Modal */}
      {isSellModalOpen && selectedStockForSell && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md m-4">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Confirm Sell</h2>
            <p className="text-gray-600 mb-6">
              Are you sure you want to sell all shares of <span className="font-semibold">{selectedStockForSell.symbol}</span> ({selectedStockForSell.companyName})?
            </p>
            
            {sellError && <p className="text-red-500 text-sm mb-4">{sellError}</p>}
            {sellSuccess && <p className="text-green-500 text-sm mb-4">{sellSuccess}</p>}

            <div className="flex justify-end space-x-4">
                              <button
                                type="button"
                                onClick={handleCloseSellModal}
                                className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors cursor-pointer"
                                disabled={isSubmittingSell}
                              >
                                Cancel
                              </button>              <button
                type="button"
                onClick={handleConfirmSell}
                className="px-6 py-2 text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:bg-gray-400 transition-colors cursor-pointer"
                disabled={isSubmittingSell}
              >
                {isSubmittingSell ? 'Selling...' : 'Confirm Sell'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Confirmation Modal */}
      {isRemoveModalOpen && selectedStockForRemove && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md m-4">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Confirm Removal</h2>
            <p className="text-gray-600 mb-6">
              Are you sure you want to remove <span className="font-semibold">{selectedStockForRemove.symbol}</span> ({selectedStockForRemove.companyName}) from your tracked stocks?
              This will also delete all associated historical data.
            </p>
            
            {removeError && <p className="text-red-500 text-sm mb-4">{removeError}</p>}
            {removeSuccess && <p className="text-green-500 text-sm mb-4">{removeSuccess}</p>}

            <div className="flex justify-end space-x-4">
                              <button
                                type="button"
                                onClick={handleCloseRemoveModal}
                                className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors cursor-pointer"
                                disabled={isSubmittingRemove}
                              >
                                Cancel
                              </button>                <button
                  type="button"
                  onClick={handleConfirmRemove}
                  className="px-6 py-2 text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:bg-gray-400 transition-colors cursor-pointer"
                  disabled={isSubmittingRemove}
                >
                  {isSubmittingRemove ? 'Removing...' : 'Confirm Remove'}
                </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
