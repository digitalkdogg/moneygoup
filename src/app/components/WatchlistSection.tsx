// src/app/components/WatchlistSection.tsx
'use client';

import { useState, useEffect, ReactNode } from 'react';
import PurchaseFromWatchlistModal from './modals/PurchaseFromWatchlistModal';
import { useRouter } from 'next/navigation';
import StockTable from './StockTable';
import { formatCurrency, formatNumber } from '@/utils/formatters';

// Define the type for a column definition for StockTable
type ColumnDefinition<T> = {
  key: keyof T | string;
  label: string;
  align?: 'left' | 'center' | 'right';
  format?: (value: any, row: T) => ReactNode;
};

interface WatchlistItem {
  stock_id: number;
  symbol: string;
  company_name: string;
  name?: string;
  shares: number;
  purchase_price: number;
  is_purchased: number;
  regularMarketPrice: number;
  prev_close?: number;
  ma6_month: number;
  recommendationKey?: string | null;
  numberOfAnalystOpinions?: number | null;
  [key: string]: any;
}

interface WatchlistSectionProps {
  onRefresh?: () => void;
}

const formatRecommendationKey = (key: string | null | undefined): string => {
  if (!key) return 'N/A';
  
  const mapping: Record<string, string> = {
    'strongBuy': 'Strong Buy',
    'buy': 'Buy',
    'hold': 'Hold',
    'sell': 'Sell',
    'strongSell': 'Strong Sell',
    'strong_buy': 'Strong Buy',
    'strong_sell': 'Strong Sell'
  };

  if (mapping[key]) return mapping[key];
  if (mapping[key.toLowerCase()]) return mapping[key.toLowerCase()];

  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
};

export default function WatchlistSection({ onRefresh }: WatchlistSectionProps) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteTicker, setPendingDeleteTicker] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<WatchlistItem | null>(null);
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetchWatchlist();
  }, []);

  const fetchWatchlist = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/user/watchlist');

      if (!response.ok) {
        throw new Error('Failed to fetch watchlist');
      }

      const data = await response.json();
      setWatchlist(data.watchlist.map((item: any) => ({
        ...item,
        name: item.company_name,
        regularMarketPrice: item.regularMarketPrice !== null ? parseFloat(item.regularMarketPrice) : 0,
        ma6_month: item.ma6_month !== null ? parseFloat(item.ma6_month) : 0
      })) || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRowClick = (symbol: string) => {
    router.push(`/search/${symbol}`);
  };

  const handlePurchase = (stock: WatchlistItem) => {
    setSelectedStock(stock);
    setShowPurchaseModal(true);
  };

  const handleRemoveClick = (stock: WatchlistItem) => {
    setPendingDeleteTicker(stock.symbol);
  };

  const handleConfirmRemove = async () => {
    if (!pendingDeleteTicker) return;
    try {
      const response = await fetch(`/api/user/watchlist?stockId=${pendingDeleteTicker}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to remove from watchlist');
      }

      setWatchlist(watchlist.filter(s => s.symbol !== pendingDeleteTicker));
      setDeleteError(null);
      fetchWatchlist();
      onRefresh?.();
    } catch (err: any) {
      setDeleteError('Failed to remove from watchlist. Please try again.');
    } finally {
      setPendingDeleteTicker(null);
    }
  };
  
  const handleModalClose = () => {
    setSelectedStock(null);
    setShowPurchaseModal(false);
    fetchWatchlist();
    onRefresh?.();
  };

  const watchlistColumns: ColumnDefinition<WatchlistItem>[] = [
    { 
      key: 'symbol', 
      label: 'Symbol',
      format: (value: string, row: WatchlistItem) => (
        <>
          <span className="block font-bold text-gray-900">{value}</span>
          <span className="block text-xs font-normal text-gray-500 truncate max-w-[150px]">{row.company_name}</span>
        </>
      )
    },
    {
      key: 'recommendationKey',
      label: 'Analyst Rec',
      align: 'left',
      format: (value: string | null, row: WatchlistItem) => (
        <>
          <span className="block font-bold text-gray-900">{formatRecommendationKey(value)}</span>
          <span className="block text-xs font-normal text-gray-500">
            {row.numberOfAnalystOpinions ? `${row.numberOfAnalystOpinions} analysts` : 'No analyst data'}
          </span>
        </>
      )
    },
    {
      key: 'regularMarketPrice',
      label: 'Price',
      align: 'right',
      format: (value: number, row: WatchlistItem) => {
        const { regularMarketPrice, prev_close } = row;
        const formattedPrice = formatCurrency(regularMarketPrice, 2);

        let percentageDisplay: ReactNode;

        if (prev_close === null || prev_close === undefined || prev_close === 0) {
          percentageDisplay = <span className="block text-xs font-normal text-gray-500">(—)</span>;
        } else {
          const dailyPercentageChange = ((regularMarketPrice - prev_close) / prev_close) * 100;
          let textColor = 'text-gray-500';
          if (dailyPercentageChange > 0) {
            textColor = 'text-green-600';
          } else if (dailyPercentageChange < 0) {
            textColor = 'text-red-600';
          }

          const formattedPercentage = formatNumber(dailyPercentageChange, 2);
          const displayPercentage = dailyPercentageChange > 0 ? `+${formattedPercentage}` : formattedPercentage;
          
          percentageDisplay = <span className={`block text-xs font-normal ${textColor}`}>({displayPercentage}%)</span>;
        }

        return (
          <span className="font-semibold">
            <span className="text-gray-600 block">{formattedPrice}</span>
            {percentageDisplay}
          </span>
        );
      }
    },
    {
      key: 'ma6_month',
      label: '6M MA',
      align: 'right',
      format: (value: number) =>
        <span className="text-gray-500 font-medium">{formatCurrency(value, 2)}</span>,
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'center',
      format: (value: any, row: WatchlistItem) => (
        <span className="flex items-center justify-center space-x-2">
          <button
            onClick={(e) => { e.stopPropagation(); handlePurchase(row); }}
            className="px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-bold text-sm cursor-pointer min-h-[44px] min-w-[120px]"
          >
            Add to Portfolio
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleRemoveClick(row); }}
            className="px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-500 transition-colors cursor-pointer font-bold text-sm min-h-[44px] min-w-[80px]"
          >
            Remove
          </button>
        </span>
      ),
    },
  ];

  return (
    <>
      {deleteError && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 mb-4">
          {deleteError}
          <button className="ml-2 underline" onClick={() => setDeleteError(null)}>Dismiss</button>
        </div>
      )}

      <StockTable<WatchlistItem>
        title="My Watchlist"
        icon="👀"
        data={watchlist}
        columns={watchlistColumns}
        onRowClick={handleRowClick}
        loading={loading}
        error={error}
        emptyMessage="Your watchlist is empty. Search for stocks to add them!"
      />

      {showPurchaseModal && selectedStock && (
        <PurchaseFromWatchlistModal stock={selectedStock} onClose={handleModalClose} />
      )}

      {pendingDeleteTicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="font-semibold text-gray-900 mb-2">Remove from watchlist?</h3>
            <p className="text-sm text-gray-600 mb-4">
              Remove <strong>{pendingDeleteTicker}</strong> from your watchlist?
            </p>
            <div className="flex gap-3 justify-end">
              <button className="px-4 py-2 text-sm rounded border cursor-pointer" onClick={() => setPendingDeleteTicker(null)}>
                Cancel
              </button>
              <button className="px-4 py-2 text-sm rounded bg-red-600 text-white cursor-pointer" onClick={handleConfirmRemove}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
