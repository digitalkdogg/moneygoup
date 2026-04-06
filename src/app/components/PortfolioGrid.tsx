'use client';

import StockCard from './StockCard';

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
            symbol={holding.symbol}
            shares={holding.shares}
            analystRec={holding.analystRec}
            analysts={holding.analysts}
            avgPrice={holding.avgPrice}
            currentPrice={holding.currentPrice}
            pctChange={holding.pctChange}
            dailyEarnings={holding.dailyEarnings}
            lifetimeEarnings={holding.lifetimeEarnings}
            positionValue={holding.positionValue}
            onBuyMore={onBuyMore}
            onSell={onSell}
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
