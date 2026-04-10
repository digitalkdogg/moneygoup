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
  changeAmount?: number | null; // Add changeAmount
  changePercent?: number | null; // Add changePercent
}

interface DeepMoneyData {
  hot_stocks: RecommendedStock[];
  hot_etfs: RecommendedETF[];
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
      
      setData({
        hot_stocks: json.hot_stocks || [],
        hot_etfs: json.hot_etfs || []
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const mapStockToDeepmoneyCard = (stock: RecommendedStock): DeepmoneyCard => ({
    variant: 'deepmoney',
    symbol: stock.ticker,
    companyName: stock.company_name,
    price: stock.current_price,
    changePercent: stock.changePercent !== undefined ? stock.changePercent : null,
    changeAmount: stock.changeAmount !== undefined ? stock.changeAmount : null,
    prediction: stock.metric_value !== undefined && stock.metric_value !== null ? stock.metric_value : (stock.trading_signal === 'BUY' ? 'Bullish' : stock.trading_signal === 'SELL' ? 'Bearish' : 'Neutral'),
    gpsScore: stock.gps_score / 10 // Convert 0-100 to 0-10 scale
  });

  const mapEtfToDeepmoneyCard = (etf: RecommendedETF): DeepmoneyCard => ({
    variant: 'deepmoney',
    symbol: etf.ticker,
    companyName: etf.etf_name,
    price: etf.current_price,
    changePercent: etf.changePercent !== undefined ? etf.changePercent : null,
    changeAmount: etf.changeAmount !== undefined ? etf.changeAmount : null,
    prediction: 'Bullish', // ETFs in this section are picked because they are "hot"
    gpsScore: etf.etf_gps_score / 10
  });

  if (loading && !data) {
    return (
      <div className="flex justify-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-10 mb-12">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-3xl font-extrabold text-gray-900 flex items-center">
          <span className="mr-3">🧠</span> DeepMoney Engine
        </h2>
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-4 py-2 bg-white border border-gray-200 rounded-xl shadow-sm text-sm text-green-700 hover:bg-gray-100 font-bold disabled:opacity-40 transition-all cursor-pointer"
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
    </div>
  );
}
