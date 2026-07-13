// src/app/components/PortfolioSection.tsx
'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import StockCard from './cards/StockCard';
import { PortfolioCard } from './cards/types';
import StockCardSection from './StockCardSection';
import { normalizeRecommendation } from '@/utils/formatters';
import { PortfolioItem } from '@/types/portfolio';

interface PortfolioSectionProps {
  portfolio: PortfolioItem[];
  horizonLabel?: string;
  onRefresh: () => void;
}

export default function PortfolioSection({ portfolio, horizonLabel = '1M' }: PortfolioSectionProps) {
  const router = useRouter();

  const mapPortfolioToCardModel = (item: PortfolioItem): PortfolioCard => {
    const { regularMarketPrice, prev_close, shares } = item;
    const pctChange = prev_close ? ((regularMarketPrice - prev_close) / prev_close) * 100 : null;
    const dollarChange = prev_close ? (regularMarketPrice - prev_close) * shares : null;

    const rawPredicted = item.predicted_price_horizon ?? item.predicted_price_1m;
    const predictedPriceHorizon = typeof rawPredicted === 'number'
      ? rawPredicted
      : typeof rawPredicted === 'string'
      ? parseFloat(rawPredicted) || null
      : null;

    return {
      variant: 'portfolio',
      symbol: item.symbol,
      companyName: item.company_name,
      sharesHeld: item.shares,
      // Prefer average_cost_basis (accurate for multi-lot holdings); fall back
      // to the initial purchase_price if the average column is not populated.
      purchasePrice: item.average_cost_basis ?? item.purchase_price ?? null,
      price: regularMarketPrice,
      changePercent: pctChange,
      changeAmount: dollarChange,
      analystFeedback: normalizeRecommendation(item.recommendationKey),
      analysts: item.numberOfAnalystOpinions,
      gpsScore: item.gpsScore,
      gpsBreakdown: item.gpsBreakdown,
      gpsHorizon: (item as any).gpsHorizon,
      topAccentColor: item.brand_color || '#017e3b',
      predictedPriceHorizon,
      horizonLabel,
      fiftyTwoWeekHigh: (item as any).fiftyTwoWeekHigh ?? null,
      logo: (item as any).logo ?? null,
    };
  };

  return (
    <StockCardSection<PortfolioItem>
      title=""
      data={portfolio}
      columns={3}
      renderCard={(item) => (
        <StockCard
          card={mapPortfolioToCardModel(item)}
          actions={{
            onCardClick: (symbol) => router.push(`/search/${symbol}`),
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
  );
}
