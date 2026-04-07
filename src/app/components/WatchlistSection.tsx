// src/app/components/WatchlistSection.tsx
'use client';

import { useState, useEffect } from 'react';
import PurchaseFromWatchlistModal from './modals/PurchaseFromWatchlistModal';
import StockCard, { UnifiedStockCardProps, StockCardMetric, StockCardAction } from './StockCard';
import StockCardSection from './StockCardSection';
import { formatCurrency, formatNumber } from '@/utils/formatters';

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

  const mapWatchlistToCardProps = (item: WatchlistItem): UnifiedStockCardProps => {
    const { regularMarketPrice, prev_close, ma6_month } = item;
    const pctChange = prev_close ? ((regularMarketPrice - prev_close) / prev_close) * 100 : null;

    const metrics: StockCardMetric[] = [
      {
        key: 'ma6_month',
        label: '6M MA',
        value: formatCurrency(ma6_month, 2),
        tone: 'neutral'
      }
    ];

    const actions: StockCardAction[] = [
      {
        key: 'addPortfolio',
        label: 'Add to Portfolio',
        variant: 'primary',
        onClick: () => handlePurchase(item)
      },
      {
        key: 'remove',
        label: 'Remove',
        variant: 'secondary',
        onClick: () => handleRemoveClick(item)
      }
    ];

    return {
      symbol: item.symbol,
      companyName: item.company_name,
      analystRec: formatRecommendationKey(item.recommendationKey),
      analysts: item.numberOfAnalystOpinions,
      price: {
        current: regularMarketPrice,
        changePct: pctChange
      },
      metrics,
      actions
    };
  };

  return (
    <>
      {deleteError && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 mb-4">
          {deleteError}
          <button className="ml-2 underline" onClick={() => setDeleteError(null)}>Dismiss</button>
        </div>
      )}

      <StockCardSection<WatchlistItem>
        title="My Watchlist"
        icon="👀"
        data={watchlist}
        renderCard={(item) => (
          <StockCard {...mapWatchlistToCardProps(item)} />
        )}
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
