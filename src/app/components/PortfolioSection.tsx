// src/app/components/PortfolioSection.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import BuyMoreModal from './modals/BuyMoreModal';
import SellModal from './modals/SellModal';
import StockCard from './cards/StockCard';
import PortfolioSummary from './PortfolioSummary'; // Import here
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
    const { regularMarketPrice, prev_close, shares } = item;
    const pctChange = prev_close ? ((regularMarketPrice - prev_close) / prev_close) * 100 : null;
    const dollarChange = prev_close ? (regularMarketPrice - prev_close) * shares : null;

    const rawPredicted = item.predicted_price_1m;
    const predictedPrice1m = typeof rawPredicted === 'number'
      ? rawPredicted
      : typeof rawPredicted === 'string'
      ? parseFloat(rawPredicted) || null
      : null;

    return {
      variant: 'portfolio',
      symbol: item.symbol,
      companyName: item.company_name,
      sharesHeld: item.shares,
      price: regularMarketPrice,
      changePercent: pctChange,
      changeAmount: dollarChange,
      analystFeedback: normalizeRecommendation(item.recommendationKey),
      analysts: item.numberOfAnalystOpinions,
      gpsScore: item.gpsScore,
      gpsBreakdown: item.gpsBreakdown,
      topAccentColor: item.brand_color || '#017e3b',
      predictedPrice1m,
    };
  };

  return (
    <>
        <StockCardSection<PortfolioItem>
            title=""
            data={portfolio}
            columns={3}
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
            emptyMessage={
              <span>
                No stocks in your portfolio yet.{' '}
                <Link href="/search" className="text-green-700 font-semibold underline hover:text-green-900">
                  Search for stocks
                </Link>
                {' '}to get started!
              </span>
            }
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
