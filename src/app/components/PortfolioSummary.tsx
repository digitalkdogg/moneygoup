// src/app/components/PortfolioSummary.tsx
'use client';

import React from 'react';
import SummaryCard from './SummaryCard';
import type { PortfolioItem } from '@/types/portfolio';

interface PortfolioSummaryProps {
  portfolio: PortfolioItem[];
  marketStatus: 'open' | 'closed'; // This will be passed from Dashboard
  showChart: boolean;
  onToggleChart: () => void;
}

const PortfolioSummary: React.FC<PortfolioSummaryProps> = ({ portfolio, marketStatus, showChart, onToggleChart }) => {
  let totalPositionValue = 0;
  let totalDailyEarnings = 0;
  let totalLifetimeEarnings = 0;

  let stocksExcludedFromDailyEarnings = 0;
  let stocksExcludedFromLifetimeEarnings = 0;

  if (!portfolio || portfolio.length === 0) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8 text-center">
        <SummaryCard label="Total Position Value" value={0} marketStatus={marketStatus} />
        <SummaryCard label="Total Daily Earnings" value={0} marketStatus={marketStatus} />
        <SummaryCard label="Total Lifetime Earnings" value={0} marketStatus={marketStatus} />
      </div>
    );
  }

  portfolio.forEach(item => {
    const { shares, regularMarketPrice, purchase_price, prev_close } = item;

    const hasValidPrevClose = prev_close !== null && prev_close !== undefined && prev_close !== 0;
    const hasValidPurchasePrice = purchase_price !== null && purchase_price !== undefined && purchase_price !== 0;

    // Box 1: Total Position Value
    totalPositionValue += shares * regularMarketPrice;

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

  const allStocksExcludedFromDailyEarnings = stocksExcludedFromDailyEarnings === portfolio.length;
  const allStocksExcludedFromLifetimeEarnings = stocksExcludedFromLifetimeEarnings === portfolio.length;


  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
      <SummaryCard
        label="Total Position Value"
        value={totalPositionValue}
        marketStatus={marketStatus}
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
  );
};

export default PortfolioSummary;