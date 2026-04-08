'use client';

import StockCard from './cards/StockCard';
import { PortfolioCard } from './cards/types';
import { formatCurrency, formatNumber, normalizeRecommendation } from '@/utils/formatters';

interface PortfolioGridItem {
  symbol: string;
  shares: number;
  analystRec: string | null;
  analysts: number | null;
  avgPrice: number;
  currentPrice: number;
  pctChange: number;
  dailyEarnings: number;
  lifetimeEarnings: number;
  positionValue: number;
}

interface PortfolioGridProps {
  holdings: PortfolioGridItem[];
  onBuyMore: (symbol: string) => void;
  onSell: (symbol: string) => void;
}

export default function PortfolioGrid({ holdings, onBuyMore, onSell }: PortfolioGridProps) {
  const mapHoldingToCardModel = (holding: PortfolioGridItem): PortfolioCard => {
    return {
      variant: 'portfolio',
      symbol: holding.symbol,
      companyName: '', // PortfolioGridItem doesn't have companyName, could be added if needed
      sharesHeld: holding.shares,
      price: holding.currentPrice,
      changePercent: holding.pctChange,
      analystFeedback: normalizeRecommendation(holding.analystRec),
      analysts: holding.analysts
    };
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-max">
      {holdings.map((holding, index) => (
        <div
          key={holding.symbol}
          style={{
            animation: `slideUp 0.4s ease-out ${index * 0.05}s backwards`,
          }}
        >
          <StockCard 
            card={mapHoldingToCardModel(holding)} 
            actions={{
              onBuyMore: () => onBuyMore(holding.symbol),
              onSell: () => onSell(holding.symbol)
            }}
          />
        </div>
      ))}

      <style>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
