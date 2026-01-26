'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { calculateTechnicalIndicators, TechnicalIndicators } from '@/utils/technicalIndicators'
import { calculateAnnualizedVolatility, getVolatilityRating } from '@/utils/volatility'
import ApiErrorDisplay, { ApiError } from './ApiErrorDisplay'
import TechnicalIndicatorsDisplay from './TechnicalIndicatorsDisplay'
import StockChart from './StockChart'
import StockNews from './StockNews'
import { createLogger } from '@/utils/logger'

const logger = createLogger('components/Stock')

interface StockData {
  symbol?: string
  name?: string
  last?: number
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  prevClose?: number
  timestamp?: string
  exchange?: string
  error?: string
  peRatio?: number
  pbRatio?: number
  marketCap?: number
}

interface HistoricalData {
  date: string
  datetime: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  adjOpen: number
  adjHigh: number
  adjLow: number
  adjClose: number
  adjVolume: number
}

type HistoricalResponse = HistoricalData[] | { error: string }

export default function Stock({
  ticker,
  source,
  companyName
}: {
  ticker: string
  source?: string
  companyName?: string
}) {
  const [stockData, setStockData] = useState<StockData | null>(null)
  const [loading, setLoading] = useState(false)
  const [indicators, setIndicators] = useState<TechnicalIndicators | null>(null)
  const [apiError, setApiError] = useState<ApiError | null>(null)
  const [volatilityRating, setVolatilityRating] =
    useState<'Low' | 'Medium' | 'High' | 'N/A' | null>(null)
  const [news, setNews] = useState<any[]>([])
  const [addingToWatchlist, setAddingToWatchlist] = useState(false)
  const [watchlistSuccess, setWatchlistSuccess] = useState<string | null>(null)
  const [watchlistError, setWatchlistError] = useState<string | null>(null)
  const [isStockOnWatchlist, setIsStockOnWatchlist] = useState(false)
  const [fullHistoricalData, setFullHistoricalData] =
    useState<HistoricalData[] | null>(null)

  const router = useRouter()

  const fetchStockData = async (ticker: string) => {
    setLoading(true);
    setStockData(null);
    setIndicators(null);
    setApiError(null);
    setVolatilityRating(null);
    setNews([]);
    setFullHistoricalData(null);
    setWatchlistSuccess(null);
    setWatchlistError(null);

    try {
      // 1. Check if stock is on user's watchlist
      const watchlistCheckRes = await fetch('/api/user/watchlist');
      if (watchlistCheckRes.ok) {
        const watchlistData = await watchlistCheckRes.json();
        const found = watchlistData.watchlist.some(
          (item: any) => item.symbol === ticker
        );
        setIsStockOnWatchlist(found);
      } else {
        logger.error('Failed to fetch user watchlist for stock check.');
        setIsStockOnWatchlist(false);
      }

      let currentStockData: StockData | null = null;
      let currentApiError: ApiError | null = null;

      try {
        const genericRes = await fetch(`/api/stock/${ticker}`);
        if (genericRes.ok) {
          currentStockData = await genericRes.json();
        } else {
          const genericErrorData = await genericRes.json();
          currentApiError = {
            type: 'stock',
            ticker,
            message:
              genericErrorData.error ||
              'Failed to fetch stock data from generic API',
            details: genericErrorData.details,
            failedServices: genericErrorData.failedServices,
          };
        }
      } catch (genericErr: unknown) {
        const err =
          genericErr instanceof Error
            ? genericErr
            : new Error(String(genericErr));

        logger.error(`Generic API network error for ${ticker}:`, err);

        currentApiError = {
          type: 'stock',
          ticker,
          message: 'Network error while fetching stock data',
          details: err.message,
          failedServices: ['Yahoo'],
        };
      }

      setStockData(currentStockData);
      setApiError(currentApiError);

      const newsRes = await fetch(`/api/stock/${ticker}/news`);
      const newsData = newsRes.ok ? await newsRes.json() : {};
      setNews(Array.isArray(newsData.articles) ? newsData.articles : []);

      const histUrl = `/api/stock/${ticker}/historical/1Y`; // Watchlist status no longer dictates historical data source

      const histRes = await fetch(histUrl);
      if (histRes.ok) {
        const data = await histRes.json();
        if (Array.isArray(data.historicalData) && data.historicalData.length) {
          setFullHistoricalData(data.historicalData);

          setIndicators(
            calculateTechnicalIndicators(
              data.historicalData,
              newsData.articles || [],
              currentStockData?.peRatio,
              currentStockData?.pbRatio,
              currentStockData?.marketCap
            )
          );

          const vol = calculateAnnualizedVolatility(data.historicalData);
          setVolatilityRating(getVolatilityRating(vol));
        }
      }
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err : new Error('Network connection failed');

      logger.error('Stock fetch failed:', error);

      setApiError({
        type: 'stock',
        ticker,
        message: 'Network error while fetching stock data',
        details: error.message,
        failedServices: ['Yahoo'],
      });

      setStockData({ error: 'Network error. Please check your connection.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (ticker) fetchStockData(ticker)
  }, [ticker])

  var currentPrice = stockData ? stockData.last || stockData.close : null
  if (currentPrice == null) {
    currentPrice = 0
  }

  const handleWatchlistToggle = async () => {
    setAddingToWatchlist(true);
    setWatchlistSuccess(null);
    setWatchlistError(null);

    try {
      let res;
      if (isStockOnWatchlist) {
        // Remove from watchlist
        res = await fetch(`/api/user/watchlist?stockId=${ticker}`, {
          method: 'DELETE',
        });
      } else {
        // Add to watchlist
        res = await fetch('/api/user/watchlist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ticker: ticker,
            name: companyName || stockData?.name || ticker, // Use companyName if available, otherwise stockData.name or ticker
          }),
        });
      }

      const data = await res.json();

      if (res.ok) {
        setWatchlistSuccess(data.message);
        setIsStockOnWatchlist(!isStockOnWatchlist);
      } else {
        setWatchlistError(data.message || 'Failed to update watchlist.');
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error('Network connection failed');
      setWatchlistError(error.message);
    } finally {
      setAddingToWatchlist(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64 flex-col mt-20">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div>
        <p className="ml-4 text-xl mt-20">Loading stock data...</p>
      </div>
    );
  }

  if (apiError) {
    return <ApiErrorDisplay error={apiError} />;
  }



  if (!stockData || !stockData.symbol) {
    return (
      <div className="text-center p-8">
      </div>
    );
  }


  return (
    <div className="container mx-auto px-0 py-8 max-w-6xl mx-auto">
      {/* Main Stock Info Card */}
      <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
        <div className="flex flex-col mb-20 text-center items-center gap-7">
          <h1 className="text-3xl font-bold text-gray-800">
            {stockData.name} ({stockData.symbol})
          </h1>
          {isStockOnWatchlist ? (
            <span className="text-green-600 font-semibold px-3 py-1 bg-green-50 w-xsrounded-full">
              On Watchlist
            </span>
          ) : (
            <button
              onClick={handleWatchlistToggle}
              disabled={addingToWatchlist}
              className="px-4 py-2 rounded-md text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-50"
            >
              {addingToWatchlist ? 'Adding...' : 'Add to Watchlist'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
            <p className="text-sm text-gray-500">Last Price</p>
            <p className="text-2xl font-bold text-gray-800">${currentPrice !== null ? currentPrice.toFixed(2) : 'N/A'}</p>
            {stockData.prevClose !== undefined && currentPrice !== null && (
              <p
                className={`text-md ${
                  (currentPrice - stockData.prevClose) >= 0
                    ? 'text-green-600'
                    : 'text-red-600'
                }`}
              >
                {(currentPrice - stockData.prevClose).toFixed(2)}{' '}
                (
                {(
                  ((currentPrice - stockData.prevClose) / stockData.prevClose) *
                  100
                ).toFixed(2)}
                %)
              </p>
            )}
          </div>

          <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
            <p className="text-sm text-gray-500">Open</p>
            <p className="text-2xl font-bold text-gray-800">${stockData.open?.toFixed(2) || 'N/A'}</p>
          </div>

          <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
            <p className="text-sm text-gray-500">Volume</p>
            <p className="text-2xl font-bold text-gray-800">{stockData.volume?.toLocaleString() || 'N/A'}</p>
          </div>

          <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
            <p className="text-sm text-gray-500">P/E Ratio</p>
            <p className="text-2xl font-bold text-gray-800">{stockData.peRatio?.toFixed(2) || 'N/A'}</p>
          </div>

          <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
            <p className="text-sm text-gray-500">P/B Ratio</p>
            <p className="text-2xl font-bold text-gray-800">{stockData.pbRatio?.toFixed(2) || 'N/A'}</p>
          </div>

          <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
            <p className="text-sm text-gray-500">Market Cap</p>
            <p className="text-2xl font-bold text-gray-800">{stockData.marketCap ? (stockData.marketCap / 1_000_000_000).toFixed(2) + 'B' : 'N/A'}</p>
          </div>
        </div>
        {watchlistSuccess && (
          <p className="text-green-600 mt-2 text-center">{watchlistSuccess}</p>
        )}
        {watchlistError && (
          <p className="text-red-600 mt-2 text-center">{watchlistError}</p>
        )}
      </div>

      {/* Price History Card */}
      {fullHistoricalData && fullHistoricalData.length > 0 && (
        <div className="mb-8">
          <StockChart ticker={ticker} historicalData={fullHistoricalData} />
        </div>
      )}

      {/* Technical Indicators Card (adjust placement as needed) */}
      {indicators && (
        <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
          <h2 className="text-2xl font-semibold text-gray-800 mb-4">🎯 Technical Indicators & Trading Signal</h2>
          <TechnicalIndicatorsDisplay indicators={indicators} />
        </div>
      )}

      {/* Latest News Card */}
      <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
        <StockNews articles={news} />
      </div>
    </div>
  );
}

