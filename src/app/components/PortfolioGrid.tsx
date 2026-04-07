'use client';

import StockCard, { UnifiedStockCardProps, StockCardMetric, StockCardAction } from './StockCard';
import { formatCurrency, formatNumber } from '@/utils/formatters';

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
  const mapHoldingToCardProps = (holding: PortfolioGridItem): UnifiedStockCardProps => {
    const metrics: StockCardMetric[] = [
      {
        key: 'dailyEarnings',
        label: 'Daily Earnings',
        value: `${holding.dailyEarnings >= 0 ? '+' : ''}${formatCurrency(holding.dailyEarnings, 2)}`,
        tone: holding.dailyEarnings >= 0 ? 'positive' : 'negative'
      },
      {
        key: 'lifetimeEarnings',
        label: 'Lifetime Earnings',
        value: `${holding.lifetimeEarnings >= 0 ? '+' : ''}${formatCurrency(holding.lifetimeEarnings, 2)}`,
        tone: holding.lifetimeEarnings >= 0 ? 'positive' : 'negative'
      },
      {
        key: 'positionValue',
        label: 'Position Value',
        value: formatCurrency(holding.positionValue, 2),
        tone: 'neutral'
      },
      {
        key: 'totalShares',
        label: 'Total Shares',
        value: formatNumber(holding.shares, 2, true),
        tone: 'neutral'
      }
    ];

    const actions: StockCardAction[] = [
      {
        key: 'buyMore',
        label: 'Buy More',
        variant: 'primary',
        onClick: () => onBuyMore(holding.symbol)
      },
      {
        key: 'sell',
        label: 'Sell',
        variant: 'secondary',
        onClick: () => onSell(holding.symbol)
      }
    ];

    return {
      symbol: holding.symbol,
      shares: holding.shares,
      analystRec: holding.analystRec,
      analysts: holding.analysts,
      price: {
        current: holding.currentPrice,
        changePct: holding.pctChange,
        avgPrice: holding.avgPrice
      },
      metrics,
      actions
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
          <StockCard {...mapHoldingToCardProps(holding)} />
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
