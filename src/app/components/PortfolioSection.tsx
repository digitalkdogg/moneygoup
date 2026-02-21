// src/app/components/PortfolioSection.tsx
'use client';

import { useState, useEffect, ReactNode } from 'react';
import BuyMoreModal from './modals/BuyMoreModal';
import SellModal from './modals/SellModal';
import { useRouter } from 'next/navigation';
import StockTable, { StockTableRow } from './StockTable'; // Import StockTable
import { formatNumber, formatCurrency } from '@/utils/formatters'; // Import formatters

// Define the type for a column definition for StockTable
type ColumnDefinition<T> = {
  key: keyof T | string;
  label: string;
  align?: 'left' | 'center' | 'right';
  format?: (value: any, row: T) => ReactNode;
};

interface PortfolioItem {
  user_id?: number;
  stock_id: number;
  symbol: string;
  company_name: string;
  name?: string; // Added to align with StockTableRow
  shares: number;
  purchase_price: number;
  initial_purchase_date?: string;
  last_transaction_date?: string;
  regularMarketPrice: number; // Renamed from current_price to align with StockTableRow
  prev_close?: number; // NEW: Previous close price
  [key: string]: any; // Add index signature for StockTableRow compatibility
}

interface PortfolioSectionProps {
  onRefresh?: () => void;
}

export default function PortfolioSection({ onRefresh }: PortfolioSectionProps) {
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<PortfolioItem | null>(null);
  const [modalType, setModalType] = useState<'buy' | 'sell' | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchPortfolio();
  }, []);

  const fetchPortfolio = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/user/portfolio');

      if (!response.ok) {
        throw new Error('Failed to fetch portfolio');
      }

      const data = await response.json();
      setPortfolio(data.portfolio.map((item: any) => ({
        ...item,
        name: item.company_name, // Map company_name to name for StockTableRow compatibility
        shares: typeof item.shares === 'string' ? parseFloat(item.shares) : 0, // Parse shares string to number, default to 0
        regularMarketPrice: typeof item.current_price === 'number' ? item.current_price : 0, // Default to 0 instead of null
        prev_close: typeof item.prev_close === 'number' ? item.prev_close : null, // NEW
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

  const handleBuyMore = (stock: PortfolioItem) => {
    setSelectedStock(stock);
    setModalType('buy');
  };

  const handleSell = (stock: PortfolioItem) => {
    setSelectedStock(stock);
    setModalType('sell');
  };

  const handleModalClose = () => {
    setSelectedStock(null);
    setModalType(null);
    fetchPortfolio();
    onRefresh?.();
  };

  const portfolioColumns: ColumnDefinition<PortfolioItem>[] = [ // Applied the type here
    { key: 'symbol', label: 'Symbol' },
    {
      key: 'shares',
      label: 'Shares',
      align: 'right',
      format: (value: number) => formatNumber(value, 2, true),
    },
    {
      key: 'purchase_price',
      label: 'Avg Price',
      align: 'right',
      format: (value: number) => formatCurrency(value, 2),
    },
    {
      key: 'regularMarketPrice',
      label: 'Current Price',
      align: 'right',
      format: (value: number, row: PortfolioItem) => {
        const { regularMarketPrice, prev_close } = row;
        const formattedCurrentPrice = formatCurrency(regularMarketPrice, 2);

        let percentageDisplay: ReactNode;

        if (prev_close === null || prev_close === undefined || prev_close === 0) {
          percentageDisplay = <span className="text-gray-500 ml-1">(—)</span>;
        } else {
          const dailyPercentageChange = ((regularMarketPrice - prev_close) / prev_close) * 100;
          let textColor = 'text-gray-500'; // Default for 0.00%
          if (dailyPercentageChange > 0) {
            textColor = 'text-green-600';
          } else if (dailyPercentageChange < 0) {
            textColor = 'text-red-600';
          }

          const formattedPercentage = formatNumber(dailyPercentageChange, 2);
          const displayPercentage = dailyPercentageChange > 0 ? `+${formattedPercentage}` : formattedPercentage;
          
          percentageDisplay = <span className={`${textColor} ml-1`}>({displayPercentage}%)</span>;
        }

        return (
          <span className="font-semibold">
            <span className="text-gray-600">{formattedCurrentPrice}</span>
            {percentageDisplay}
          </span>
        );
      },
    },
    {
      key: 'dailyEarnings', // A new key for this column
      label: 'Daily Earnings',
      align: 'right',
      format: (value: any, row: PortfolioItem) => {
        const { shares, regularMarketPrice, prev_close } = row;

        if (shares === 0) {
          return <span className="text-gray-500">{formatCurrency(0, 2)}</span>; // $0.00 for 0 shares
        }

        if (prev_close === null || prev_close === undefined) {
          return <span className="text-gray-500">—</span>; // Em dash for unavailable prevClose
        }

        const dailyEarnings = shares * (regularMarketPrice - prev_close);
        let textColor = 'text-gray-500'; // Default for $0.00
        if (dailyEarnings > 0) {
          textColor = 'text-green-600';
        } else if (dailyEarnings < 0) {
          textColor = 'text-red-600';
        }

        const formattedEarnings = formatCurrency(dailyEarnings, 2);
        // Add + prefix for positive values
        const displayValue = dailyEarnings > 0 ? `+${formattedEarnings}` : formattedEarnings;

        return <span className={`${textColor} font-semibold`}>{displayValue}</span>;
      },
    },
    {
      key: 'lifetimeEarnings', // A new key for this column
      label: 'Lifetime Earnings',
      align: 'right',
      format: (value: any, row: PortfolioItem) => {
        const { shares, regularMarketPrice, purchase_price } = row;

        if (shares === 0) {
          return <span className="text-gray-500">{formatCurrency(0, 2)}</span>; // $0.00 for 0 shares
        }

        if (purchase_price === null || purchase_price === undefined || purchase_price === 0) {
          return <span className="text-gray-500">—</span>; // Em dash for unavailable Avg Price
        }

        const lifetimeEarnings = (regularMarketPrice * shares) - (purchase_price * shares);
        let textColor = 'text-gray-500'; // Default for $0.00
        if (lifetimeEarnings > 0) {
          textColor = 'text-green-600';
        } else if (lifetimeEarnings < 0) {
          textColor = 'text-red-600';
        }

        const formattedEarnings = formatCurrency(lifetimeEarnings, 2);
        // Add + prefix for positive values
        const displayValue = lifetimeEarnings > 0 ? `+${formattedEarnings}` : formattedEarnings;

        return <span className={`${textColor} font-semibold`}>{displayValue}</span>;
      },
    },
    {
      key: 'positionValue',
      label: 'Position Value',
      align: 'right',
      format: (value: any, row: PortfolioItem) => {
        const positionValue = row.shares * row.purchase_price; // Initial calculation
        if (row.regularMarketPrice !== 0) { // Only use current market price if available
          return <span className="text-green-600 font-semibold">{formatCurrency(row.shares * row.regularMarketPrice, 2)}</span>;
        }
        return <span className="text-gray-500 font-semibold">{formatCurrency(positionValue, 2)}</span>; // Fallback or if current price is 0
      },
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'center',
      format: (value: any, row: PortfolioItem) => (
        <span className="space-x-2">
          <button
            onClick={(e) => { e.stopPropagation(); handleBuyMore(row); }}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold text-sm cursor-pointer" 
          >
            Buy More
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleSell(row); }}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-500 transition-colors cursor-pointer font-semibold text-sm"
          >
            Sell
          </button>
        </span>
      ),
    },
  ];

  return (
    <>
      <StockTable<PortfolioItem>
        title="My Portfolio"
        icon="📈"
        data={portfolio}
        columns={portfolioColumns}
        onRowClick={handleRowClick}
        loading={loading}
        error={error}
        emptyMessage="No stocks in your portfolio yet. Add stocks from your watchlist to get started!"
      />

      {modalType === 'buy' && selectedStock && (
        <BuyMoreModal stock={selectedStock} onClose={handleModalClose} />
      )}

      {modalType === 'sell' && selectedStock && (
        <SellModal stock={selectedStock} onClose={handleModalClose} />
      )}
    </>
  );
}