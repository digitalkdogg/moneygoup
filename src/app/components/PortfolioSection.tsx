// src/app/components/PortfolioSection.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import BuyMoreModal from './modals/BuyMoreModal';
import SellModal from './modals/SellModal';
import StockCard from './cards/StockCard';
import { PortfolioCard } from './cards/types';
import StockCardSection from './StockCardSection';
import { formatNumber, formatCurrency, normalizeRecommendation } from '@/utils/formatters';
import { PortfolioItem } from '@/types/portfolio';

interface PortfolioSectionProps {
  portfolio: PortfolioItem[];
  onRefresh: () => void;
}

export default function PortfolioSection({ portfolio, onRefresh }: PortfolioSectionProps) {
  const [selectedStock, setSelectedStock] = useState<PortfolioItem | null>(null);
  const [modalType, setModalType] = useState<'buy' | 'sell' | null>(null);
  const router = useRouter();

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

  const mapPortfolioToCardModel = (item: PortfolioItem): PortfolioCard => {
    const { regularMarketPrice, prev_close } = item;
    const pctChange = prev_close ? ((regularMarketPrice - prev_close) / prev_close) * 100 : null;

    return {
      variant: 'portfolio',
      symbol: item.symbol,
      companyName: item.company_name,
      sharesHeld: item.shares,
      price: regularMarketPrice,
      changePercent: pctChange,
      analystFeedback: normalizeRecommendation(item.recommendationKey),
      analysts: item.numberOfAnalystOpinions
    };
  };

  return (
    <>
      <StockCardSection<PortfolioItem>
        title="My Portfolio"
        icon="📈"
        data={portfolio}
        renderCard={(item) => (
          <StockCard 
            card={mapPortfolioToCardModel(item)} 
            actions={{
              onBuyMore: () => handleBuyMore(item),
              onSell: () => handleSell(item),
              onCardClick: (symbol) => router.push(`/search/${symbol}`)
            }}
          />
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
