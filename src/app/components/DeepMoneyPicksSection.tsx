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
  changeAmount?: number | null; // Add changeAmount
  changePercent?: number | null; // Add changePercent
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

interface DeepMoneyData {
  hot_stocks: RecommendedStock[];
  hot_etfs: RecommendedETF[];
  etf_holdings: RecommendedETFHolding[];
  timeframe_label?: string | null;
}

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
      
      const sortedHotStocks = (json.hot_stocks || []).sort((a: RecommendedStock, b: RecommendedStock) => (b.gps_score || 0) - (a.gps_score || 0));
      const sortedHotEtfs = (json.hot_etfs || []).sort((a: RecommendedETF, b: RecommendedETF) => (b.etf_gps_score || 0) - (a.etf_gps_score || 0));

      setData({
        hot_stocks: sortedHotStocks,
        hot_etfs: sortedHotEtfs,
        etf_holdings: (json.etf_holdings || []).sort((a: RecommendedETFHolding, b: RecommendedETFHolding) => (b.gps_score || 0) - (a.gps_score || 0)),
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

      <StockCardSection<RecommendedStock>
        title="Top Growth Candidates"
        icon="🔥"
        data={data?.hot_stocks || []}
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

      {(data?.etf_holdings?.length ?? 0) > 0 && (
        <StockCardSection<RecommendedETFHolding>
          title="Surfaced ETF Holdings"
          icon="📡"
          data={data?.etf_holdings || []}
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
