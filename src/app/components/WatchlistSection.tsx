// src/app/components/WatchlistSection.tsx
'use client';

import { useState, useEffect, ReactNode } from 'react';
import PurchaseFromWatchlistModal from './modals/PurchaseFromWatchlistModal';
import { useRouter } from 'next/navigation';
import StockTable, { StockTableRow } from './StockTable'; // Import StockTable
import { formatCurrency } from '@/utils/formatters'; // Import formatters

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
  name?: string; // Added to align with StockTableRow
  shares: number;
  purchase_price: number;
  is_purchased: number;
  regularMarketPrice: number; // Renamed from current_price to align with StockTableRow
  ma6_month: number; // Changed from number | null to number
  [key: string]: any; // Add index signature for StockTableRow compatibility
}

interface WatchlistSectionProps {
  onRefresh?: () => void;
}

export default function WatchlistSection({ onRefresh }: WatchlistSectionProps) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); // Keep this existing error state
  const [pendingDeleteTicker, setPendingDeleteTicker] = useState<string | null>(null); // Corrected
  const [deleteError, setDeleteError] = useState<string | null>(null); // Corrected
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
        name: item.company_name, // Map company_name to name for StockTableRow compatibility
        regularMarketPrice: item.regularMarketPrice !== null ? parseFloat(item.regularMarketPrice) : 0, // Default to 0 instead of null
        ma6_month: item.ma6_month !== null ? parseFloat(item.ma6_month) : 0 // Default to 0 instead of null
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
    setPendingDeleteTicker(stock.symbol); // Opens the confirm modal
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
      fetchWatchlist(); // Refresh the watchlist after successful deletion
      onRefresh?.();
    } catch (err: any) {
      setDeleteError('Failed to remove from watchlist. Please try again.');
    } finally {
      setPendingDeleteTicker(null); // Close modal regardless
    }
  };
  
  const handleModalClose = () => {
    setSelectedStock(null);
    setShowPurchaseModal(false);
    fetchWatchlist();
    onRefresh?.();
  };

  const watchlistColumns: ColumnDefinition<WatchlistItem>[] = [
    { key: 'symbol', label: 'Symbol' },
    { key: 'company_name', label: 'Company Name' },
    {
      key: 'regularMarketPrice',
      label: 'Price',
      align: 'right',
      format: (value: number) =>
        <span className="text-gray-600 font-semibold">{formatCurrency(value, 2)}</span>,
    },
    {
      key: 'ma6_month',
      label: '6M MA',
      align: 'right',
      format: (value: number) =>
        <span className="text-gray-500">{formatCurrency(value, 2)}</span>,
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'center',
      format: (value: any, row: WatchlistItem) => (
        <span className="space-x-2">
          <button
            onClick={(e) => { e.stopPropagation(); handlePurchase(row); }}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold cursor-pointer text-sm"
          >
            Add to Portfolio
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleRemoveClick(row); }}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-500 transition-colors cursor-pointer font-semibold text-sm"
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
              <button className="px-4 py-2 text-sm rounded border" onClick={() => setPendingDeleteTicker(null)}>
                Cancel
              </button>
              <button className="px-4 py-2 text-sm rounded bg-red-600 text-white" onClick={handleConfirmRemove}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}