// src/app/components/PortfolioSummary.tsx
'use client';

import React from 'react';
import SummaryCard from './SummaryCard';

interface PortfolioItem {
  user_id?: number;
  stock_id: number;
  symbol: string;
  company_name: string;
  name?: string;
  shares: number;
  purchase_price: number;
  initial_purchase_date?: string;
  last_transaction_date?: string;
  regularMarketPrice: number;
  prev_close?: number;
}

interface PortfolioSummaryProps {
  portfolio: PortfolioItem[];
  marketStatus: 'open' | 'closed'; // This will be passed from Dashboard
}

const PortfolioSummary: React.FC<PortfolioSummaryProps> = ({ portfolio, marketStatus }) => {
  let totalDailyChange = 0;
  let totalDailyEarnings = 0;
  let totalLifetimeEarnings = 0;

  let stocksExcludedFromDailyChange = 0;
  let stocksExcludedFromDailyEarnings = 0;
  let stocksExcludedFromLifetimeEarnings = 0;

  if (!portfolio || portfolio.length === 0) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-lg mb-8">
        <h2 className="text-2xl font-bold text-gray-800 mb-4">Portfolio Summary</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-center">
          <SummaryCard label="Total Daily Change" value={0} marketStatus={marketStatus} />
          <SummaryCard label="Total Daily Earnings" value={0} marketStatus={marketStatus} />
          <SummaryCard label="Total Lifetime Earnings" value={0} marketStatus={marketStatus} />
        </div>
      </div>
    );
  }

  portfolio.forEach(item => {
    const { shares, regularMarketPrice, purchase_price, prev_close } = item;

    const hasValidPrevClose = prev_close !== null && prev_close !== undefined && prev_close !== 0;
    const hasValidPurchasePrice = purchase_price !== null && purchase_price !== undefined && purchase_price !== 0;

    // Box 1: Total Daily Change
    // Exclude if prev_close is missing. If all stocks are excluded, display '—'.
    if (hasValidPrevClose) {
      totalDailyChange += (regularMarketPrice - prev_close!);
    } else {
      stocksExcludedFromDailyChange++;
    }

    // Box 2: Total Daily Earnings
    // Exclude if shares > 0 and prev_close is missing.
    if (shares > 0 && hasValidPrevClose) {
      totalDailyEarnings += shares * (regularMarketPrice - prev_close!);
    } else if (shares > 0) { // Shares > 0 but prev_close is missing
      stocksExcludedFromDailyEarnings++;
    }
    // If shares is 0, it contributes 0 and isn't "excluded" due to missing prev_close

    // Box 3: Total Lifetime Earnings
    // Exclude if shares > 0 and purchase_price is missing.
    if (shares > 0 && hasValidPurchasePrice) {
      totalLifetimeEarnings += (regularMarketPrice * shares) - (purchase_price! * shares);
    } else if (shares > 0) { // Shares > 0 but purchase_price is missing
      stocksExcludedFromLifetimeEarnings++;
    }
    // If shares is 0, it contributes 0 and isn't "excluded" due to missing cost basis
  });

  const allStocksExcludedFromDailyChange = stocksExcludedFromDailyChange === portfolio.length;
  const allStocksExcludedFromDailyEarnings = stocksExcludedFromDailyEarnings === portfolio.length;
  const allStocksExcludedFromLifetimeEarnings = stocksExcludedFromLifetimeEarnings === portfolio.length;


  return (
    <div className="bg-white p-6 rounded-2xl shadow-lg mb-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-4">Portfolio Summary</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-center">
        <SummaryCard
          label="Total Daily Change"
          value={allStocksExcludedFromDailyChange ? null : totalDailyChange}
          marketStatus={marketStatus}
          isMissingData={stocksExcludedFromDailyChange > 0 && !allStocksExcludedFromDailyChange}
          tooltip={stocksExcludedFromDailyChange > 0 && !allStocksExcludedFromDailyChange ? "One or more stocks excluded due to missing price history" : undefined}
        />
        <SummaryCard
          label="Total Daily Earnings"
          value={allStocksExcludedFromDailyEarnings ? null : totalDailyEarnings}
          marketStatus={marketStatus}
          isMissingData={stocksExcludedFromDailyEarnings > 0 && !allStocksExcludedFromDailyEarnings}
          tooltip={stocksExcludedFromDailyEarnings > 0 && !allStocksExcludedFromDailyEarnings ? "One or more stocks excluded due to missing price history" : undefined}
        />
        <SummaryCard
          label="Total Lifetime Earnings"
          value={totalLifetimeEarnings}
          marketStatus={marketStatus}
          isMissingData={stocksExcludedFromLifetimeEarnings > 0}
          tooltip={stocksExcludedFromLifetimeEarnings > 0 ? "One or more stocks excluded due to missing cost basis" : undefined}
        />
      </div>
    </div>
  );
};

export default PortfolioSummary;
