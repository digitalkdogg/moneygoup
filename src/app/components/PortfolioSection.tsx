// src/app/components/PortfolioSection.tsx
'use client';

import { useState } from 'react';
import BuyMoreModal from './modals/BuyMoreModal';
import SellModal from './modals/SellModal';
import StockCard, { UnifiedStockCardProps, StockCardMetric, StockCardAction } from './StockCard';
import StockCardSection from './StockCardSection';
import { formatNumber, formatCurrency } from '@/utils/formatters';
import { PortfolioItem } from '@/types/portfolio';

interface PortfolioSectionProps {
  portfolio: PortfolioItem[];
  onRefresh: () => void;
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

export default function PortfolioSection({ portfolio, onRefresh }: PortfolioSectionProps) {
  const [selectedStock, setSelectedStock] = useState<PortfolioItem | null>(null);
  const [modalType, setModalType] = useState<'buy' | 'sell' | null>(null);

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
    onRefresh();
  };

  const mapPortfolioToCardProps = (item: PortfolioItem): UnifiedStockCardProps => {
    const { shares, regularMarketPrice, prev_close, purchase_price } = item;
    
    const dailyEarnings = prev_close ? shares * (regularMarketPrice - prev_close) : null;
    const lifetimeEarnings = purchase_price ? (regularMarketPrice * shares) - (purchase_price * shares) : null;
    const positionValue = regularMarketPrice * shares;
    const pctChange = prev_close ? ((regularMarketPrice - prev_close) / prev_close) * 100 : null;

    const metrics: StockCardMetric[] = [];
    
    if (dailyEarnings !== null) {
      metrics.push({
        key: 'dailyEarnings',
        label: 'Daily Earnings',
        value: `${dailyEarnings >= 0 ? '+' : ''}${formatCurrency(dailyEarnings, 2)}`,
        tone: dailyEarnings >= 0 ? 'positive' : 'negative'
      });
    }

    if (lifetimeEarnings !== null) {
      metrics.push({
        key: 'lifetimeEarnings',
        label: 'Lifetime Earnings',
        value: `${lifetimeEarnings >= 0 ? '+' : ''}${formatCurrency(lifetimeEarnings, 2)}`,
        tone: lifetimeEarnings >= 0 ? 'positive' : 'negative'
      });
    }

    metrics.push({
      key: 'positionValue',
      label: 'Position Value',
      value: formatCurrency(positionValue, 2),
      tone: 'neutral'
    });

    metrics.push({
      key: 'totalShares',
      label: 'Total Shares',
      value: formatNumber(shares, 2, true),
      tone: 'neutral'
    });

    const actions: StockCardAction[] = [
      {
        key: 'buyMore',
        label: 'Buy More',
        variant: 'primary',
        onClick: () => handleBuyMore(item)
      },
      {
        key: 'sell',
        label: 'Sell',
        variant: 'secondary',
        onClick: () => handleSell(item)
      }
    ];

    return {
      symbol: item.symbol,
      companyName: item.company_name,
      shares: item.shares,
      analystRec: formatRecommendationKey(item.recommendationKey),
      analysts: item.numberOfAnalystOpinions,
      price: {
        current: regularMarketPrice,
        changePct: pctChange,
        avgPrice: purchase_price
      },
      metrics,
      actions
    };
  };

  return (
    <>
      <StockCardSection<PortfolioItem>
        title="My Portfolio"
        icon="📈"
        data={portfolio}
        renderCard={(item) => (
          <StockCard {...mapPortfolioToCardProps(item)} />
        )}
        loading={false}
        error={null}
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
