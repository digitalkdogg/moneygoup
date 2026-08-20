'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import StockCard from './cards/StockCard';
import { DeepmoneyCard } from './cards/types';
import StockCardSection from './StockCardSection';

interface OffMarketMover {
  ticker: string;
  company_name: string;
  current_price: number | null;
  metric_value: number;
  metric_label: string;
  discovery_source: string;
}

const MOVERS_MAX = 4;

function mapToCard(m: OffMarketMover): DeepmoneyCard {
  const changePct = Number(m.metric_value);
  return {
    variant: 'deepmoney',
    symbol: m.ticker,
    companyName: m.company_name,
    price: m.current_price,
    changePercent: changePct,
    changeAmount: null,
    prediction: changePct > 0 ? 'Bullish' : 'Bearish',
    gpsScore: null,
    gpsBreakdown: null,
    timeframeLabel: null,
    offMarketMover: {
      marketState: m.discovery_source === 'pre_market' ? 'PRE' : 'POST',
      changePct,
    },
  };
}

export default function DashboardMoversSection() {
  const router = useRouter();
  const [movers, setMovers] = useState<OffMarketMover[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchMovers = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/deepmoney-picks');
      if (!res.ok) return;
      const json = await res.json();
      const raw: OffMarketMover[] = json.off_market_movers ?? [];
      const sorted = [...raw].sort((a, b) => Math.abs(Number(b.metric_value)) - Math.abs(Number(a.metric_value)));
      setMovers(sorted.slice(0, MOVERS_MAX));
    } catch {
      // silently skip — movers are supplemental, not critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMovers(); }, [fetchMovers]);

  if (!loading && movers.length === 0) return null;

  return (
    <StockCardSection<OffMarketMover>
      title="Off Market Movers"
      icon="⚡"
      data={movers}
      renderCard={(mover) => (
        <StockCard
          card={mapToCard(mover)}
          actions={{ onCardClick: (symbol) => router.push(`/search/${symbol}`) }}
        />
      )}
      loading={loading}
      error={null}
      emptyMessage=""
    />
  );
}
