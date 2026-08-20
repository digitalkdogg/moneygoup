// src/app/components/DeepMoneyPicksSection.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import StockCard from './cards/StockCard';
import { DeepmoneyCard } from './cards/types';
import StockCardSection from './StockCardSection';

interface RecommendedStock {
  id: number;
  type: string;
  ticker: string;
  company_name: string;
  current_price: number;
  gps_score: number;
  gps_breakdown?: any;
  classification: string;
  trading_signal?: string;
  metric_value?: number;
  changeAmount?: number | null;
  changePercent?: number | null;
  consecutive_days?: number | null;
}

interface RecommendedETF {
  id: number;
  ticker: string;
  etf_name: string;
  current_price: number;
  etf_gps_score: number;
  theme: string;
  changeAmount?: number | null;
  changePercent?: number | null;
}

interface RecommendedETFHolding {
  id: number;
  ticker: string;
  company_name: string;
  gps_score: number;
  gps_breakdown?: any;
  parent_etf_ticker: string;
  holding_percent: number;
  bearish_signal: number;
  metric_value?: number;
  metric_label?: string;
}

interface RecommendedOffMarketMover {
  ticker: string;
  company_name: string;
  current_price: number | null;
  metric_value: number;       // change %
  metric_label: string;       // 'Pre-Market' | 'After-Hours'
  discovery_source: string;   // 'pre_market' | 'after_hours'
}

interface DeepMoneyData {
  hot_stocks: RecommendedStock[];
  hot_etfs: RecommendedETF[];
  etf_holdings: RecommendedETFHolding[];
  off_market_movers: RecommendedOffMarketMover[];
  timeframe_label?: string | null;
}

// Cap for the discovery + ETF holdings sections (movers are shown separately above).
const TOTAL_CAP    = 16;
const HOLDINGS_MAX = 4;

export default function DeepMoneyPicksSection() {
  const router = useRouter();
  const [data, setData] = useState<DeepMoneyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/deepmoney-picks');
      if (!res.ok) throw new Error('Failed to fetch DeepMoney picks');
      const json = await res.json();

      setData({
        hot_stocks: (json.hot_stocks || []).sort((a: RecommendedStock, b: RecommendedStock) => (b.gps_score || 0) - (a.gps_score || 0)),
        hot_etfs: (json.hot_etfs || []).sort((a: RecommendedETF, b: RecommendedETF) => (b.etf_gps_score || 0) - (a.etf_gps_score || 0)),
        etf_holdings: (json.etf_holdings || []).sort((a: RecommendedETFHolding, b: RecommendedETFHolding) => (b.gps_score || 0) - (a.gps_score || 0)),
        off_market_movers: (json.off_market_movers || []).filter((m: RecommendedOffMarketMover) => Number(m.metric_value) > 0).sort((a: RecommendedOffMarketMover, b: RecommendedOffMarketMover) => Number(b.metric_value) - Number(a.metric_value)),
        timeframe_label: json.timeframe_label ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const timeframeLabel = data?.timeframe_label ?? null;

  // Movers are uncapped on the search page — show all positive ones from the API.
  // Discovery + ETF share TOTAL_CAP independently so movers don't eat their slots.
  const displayedMovers   = data?.off_market_movers ?? [];
  const holdingsCount     = Math.min(data?.etf_holdings?.length ?? 0, HOLDINGS_MAX);
  const discoveryCount    = Math.max(0, TOTAL_CAP - holdingsCount);

  const displayedHoldings = (data?.etf_holdings ?? []).slice(0, holdingsCount);
  const displayedStocks   = (data?.hot_stocks ?? []).slice(0, discoveryCount);

  // Suppress tickers already shown as movers from other sections.
  const moverTickers = new Set(displayedMovers.map(m => m.ticker));
  const filteredStocks   = displayedStocks.filter(s => !moverTickers.has(s.ticker));
  const filteredHoldings = displayedHoldings.filter(h => !moverTickers.has(h.ticker));

  const mapStockToDeepmoneyCard = (stock: RecommendedStock): DeepmoneyCard => ({
    variant: 'deepmoney',
    symbol: stock.ticker,
    companyName: stock.company_name,
    price: stock.current_price,
    changePercent: stock.changePercent !== undefined ? stock.changePercent : null,
    changeAmount: stock.changeAmount !== undefined ? stock.changeAmount : null,
    prediction: stock.metric_value !== undefined && stock.metric_value !== null ? stock.metric_value : (stock.trading_signal === 'BUY' ? 'Bullish' : stock.trading_signal === 'SELL' ? 'Bearish' : 'Neutral'),
    gpsScore: stock.gps_score !== null ? parseFloat(stock.gps_score as any) : null,
    gpsBreakdown: stock.gps_breakdown ? (typeof stock.gps_breakdown === 'string' ? JSON.parse(stock.gps_breakdown) : stock.gps_breakdown) : null,
    timeframeLabel,
    consecutiveDays: stock.consecutive_days ?? null,
  });

  const mapEtfToDeepmoneyCard = (etf: RecommendedETF): DeepmoneyCard => ({
    variant: 'deepmoney',
    symbol: etf.ticker,
    companyName: etf.etf_name,
    price: etf.current_price,
    changePercent: etf.changePercent !== undefined ? etf.changePercent : null,
    changeAmount: etf.changeAmount !== undefined ? etf.changeAmount : null,
    prediction: 'Bullish',
    gpsScore: etf.etf_gps_score !== null ? parseFloat(etf.etf_gps_score as any) : null,
    gpsBreakdown: null,
    timeframeLabel,
  });

  const mapETFHoldingToDeepmoneyCard = (h: RecommendedETFHolding): DeepmoneyCard => ({
    variant: 'deepmoney',
    symbol: h.ticker,
    companyName: h.parent_etf_ticker
      ? `${h.company_name} · ${h.parent_etf_ticker} (${((h.holding_percent || 0) * 100).toFixed(1)}%)`
      : h.company_name,
    price: null,
    changePercent: null,
    changeAmount: null,
    prediction: typeof h.metric_value === 'number' ? h.metric_value : null,
    gpsScore: h.gps_score !== null ? parseFloat(h.gps_score as any) : null,
    gpsBreakdown: h.gps_breakdown
      ? (typeof h.gps_breakdown === 'string' ? JSON.parse(h.gps_breakdown) : h.gps_breakdown)
      : null,
    timeframeLabel,
  });

  const mapMoverToDeepmoneyCard = (m: RecommendedOffMarketMover): DeepmoneyCard => {
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
      timeframeLabel,
      offMarketMover: {
        marketState: m.discovery_source === 'pre_market' ? 'PRE' : 'POST',
        changePct,
      },
    };
  };

  if (loading && !data) {
    return (
      <div className="flex justify-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-10 mb-12 section-deepmoney-engine">
      <div className="flex items-center justify-between px-2">
        <h2 className="section-heading">DeepMoney Engine</h2>
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-4 py-2 bg-white border border-gray-200 rounded-xl shadow-sm text-green-700 hover:bg-gray-100 disabled:opacity-40 transition-all cursor-pointer"
        >
          {loading ? 'Analyzing...' : '↻ Refresh Analysis'}
        </button>
      </div>

      {displayedMovers.length > 0 && (
        <StockCardSection<RecommendedOffMarketMover>
          title="Off Market Movers"
          icon="⚡"
          data={displayedMovers}
          renderCard={(mover) => (
            <StockCard
              card={mapMoverToDeepmoneyCard(mover)}
              actions={{ onCardClick: (symbol) => router.push(`/search/${symbol}`) }}
            />
          )}
          loading={loading}
          error={null}
          emptyMessage=""
        />
      )}

      <StockCardSection<RecommendedStock>
        title="Top Growth Candidates"
        icon="🔥"
        data={filteredStocks}
        renderCard={(stock) => (
          <StockCard
            card={mapStockToDeepmoneyCard(stock)}
            actions={{ onCardClick: (symbol) => router.push(`/search/${symbol}`) }}
          />
        )}
        loading={loading}
        error={error}
        emptyMessage="No top growth picks available today."
      />

      <StockCardSection<RecommendedETF>
        title="Hot ETFs Under $300"
        icon="🧺"
        data={data?.hot_etfs || []}
        renderCard={(etf) => (
          <StockCard
            card={mapEtfToDeepmoneyCard(etf)}
            actions={{ onCardClick: (symbol) => router.push(`/search/${symbol}`) }}
          />
        )}
        loading={loading}
        error={error}
        emptyMessage="No hot ETFs matching your criteria found today."
      />

      {filteredHoldings.length > 0 && (
        <StockCardSection<RecommendedETFHolding>
          title="Surfaced ETF Holdings"
          icon="📡"
          data={filteredHoldings}
          renderCard={(holding) => (
            <StockCard
              card={mapETFHoldingToDeepmoneyCard(holding)}
              actions={{ onCardClick: (symbol) => router.push(`/search/${symbol}`) }}
            />
          )}
          loading={loading}
          error={error}
          emptyMessage="No surfaced ETF holdings today."
        />
      )}
    </div>
  );
}
