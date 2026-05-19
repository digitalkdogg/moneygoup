'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { TechnicalIndicators } from '@/utils/technicalIndicators'
import { getVolatilityRating } from '@/utils/volatility'
import ApiErrorDisplay, { ApiError } from './ApiErrorDisplay'
import TechnicalIndicatorsDisplay from './TechnicalIndicatorsDisplay'
import StockChart from './StockChart'
import StockNews from './StockNews'
import { createLogger } from '@/utils/logger'
import StockPrediction from './StockPrediction'
import StockSignalPanel, { GpsData } from './StockSignalPanel'
import { formatNumber, formatCurrency } from '@/utils/formatters' // Added import

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
  longBusinessSummary?: string // Added company description
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

interface RecommendationTrendItem {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

interface ConsolidatedStockData {
  stock: StockData
  news: any
  historical: any
  indicators: TechnicalIndicators | null
  earnings: EarningsData | null // Add earnings data
  analyst: { // Assuming this structure based on route.ts and JSX usage
    recommendationTrend: RecommendationTrendItem[];
    recommendationKey: string | null;
    numberOfAnalystOpinions: number | null;
    priceTarget: {
      low: number | null;
      mean: number | null;
      median: number | null;
      high: number | null;
      current: number | null;
    };
  } | null;
}

interface EarningsData {
  upcomingEarnings: string | null;
  historicalEarnings: {
    date: string;
    revenue: number | null;
    earnings: number | null;
    epsActual: number | null;
    epsEstimate: number | null;
  }[];
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
  const [stockDataMap, setStockDataMap] = useState<Record<string, ConsolidatedStockData>>({})
  const [loading, setLoading] = useState(false)
  const [apiError, setApiError] = useState<ApiError | null>(null)
  const [volatilityRating, setVolatilityRating] =
    useState<'Low' | 'Medium' | 'High' | 'N/A' | null>(null)
  const [addingToWatchlist, setAddingToWatchlist] = useState(false)
  const [watchlistSuccess, setWatchlistSuccess] = useState<string | null>(null)
  const [watchlistError, setWatchlistError] = useState<string | null>(null)
  const [watchlistStatus, setWatchlistStatus] = useState<Record<string, boolean>>({})
  const [portfolioStatus, setPortfolioStatus] = useState<Record<string, boolean>>({})
  const [portfolioData, setPortfolioData] = useState<Record<string, { shares: number; purchaseDate: string | null; purchasePrice: number }>>({})
  const [earningsData, setEarningsData] = useState<EarningsData | null>(null);
  const [showFullSummary, setShowFullSummary] = useState(false); // State for showing full summary
  const TRUNCATE_LENGTH = 300; // Define truncation length

  const [gpsData, setGpsData] = useState<GpsData | null>(null)
  const [gpsLoading, setGpsLoading] = useState(false)
  const [predictionLoading, setPredictionLoading] = useState(false)
  const predictionTriggerRef = useRef<() => void>(() => {})
  const onPredictionLoadingChange = useCallback((v: boolean) => setPredictionLoading(v), [])

  const router = useRouter()

  // Normalize tickers
  const tickerArray = ticker.split(',').map(t => t.trim().toUpperCase())
  const isSingleTicker = tickerArray.length === 1
  const primaryTicker = tickerArray[0]

  const refreshGps = useCallback(() => {
    if (!isSingleTicker) return
    setGpsLoading(true)
    fetch(`/api/stock_data/${primaryTicker}/gps`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setGpsData(d))
      .catch(() => {})
      .finally(() => setGpsLoading(false))
  }, [primaryTicker, isSingleTicker])

      const formatDate = (dateString: string) => {
        if (!dateString) return 'N/A';
  
        // Check for "XQYYYY" format (e.g., "1Q2025")
        const quarterMatch = dateString.match(/(\d)Q(\d{4})/);
        if (quarterMatch) {
          const quarter = quarterMatch[1];
          const year = quarterMatch[2];
          return `Q${quarter} ${year}`; // Format as "Q1 2025"
        }
  
        // Fallback for standard date strings
        try {
          return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          });
        } catch {
          return 'N/A';
        }
      };
  const fetchStockData = async (tickerString: string) => {
    setLoading(true)
    setStockDataMap({})
    setApiError(null)
    setVolatilityRating(null)
    setWatchlistSuccess(null)
    setWatchlistError(null)

    try {
      // 1. Check watchlist status
      if (isSingleTicker) {
        const watchlistRes = await fetch(`/api/dashboard/on?ticker=${primaryTicker}`);
        if (watchlistRes.ok) {
          const { onWatchlist, onPortfolio, shares, purchaseDate, purchasePrice } = await watchlistRes.json();
          // If stock is in portfolio, treat it as on watchlist
          const effectiveWatchlistStatus = onWatchlist || onPortfolio;
          setWatchlistStatus({ [primaryTicker]: effectiveWatchlistStatus });
          setPortfolioStatus({ [primaryTicker]: onPortfolio });
          setPortfolioData({ [primaryTicker]: { shares, purchaseDate, purchasePrice } });
        } else {
          logger.error('Failed to fetch single stock watchlist status');
          setWatchlistStatus({ [primaryTicker]: false });
          setPortfolioStatus({ [primaryTicker]: false });
          setPortfolioData({ [primaryTicker]: { shares: 0, purchaseDate: null, purchasePrice: 0 } });
        }
      } else {
        const watchlistCheckRes = await fetch('/api/user/watchlist');
        if (watchlistCheckRes.ok) {
          const watchlistData = await watchlistCheckRes.json();
          const statusMap: Record<string, boolean> = {};
          const portfolioMap: Record<string, boolean> = {};
          tickerArray.forEach(t => {
            statusMap[t] = watchlistData.watchlist.some(
              (item: any) => item.symbol?.trim().toUpperCase() === t
            );
            portfolioMap[t] = false; // Portfolio status not needed for multi-ticker comparison
          });
          setWatchlistStatus(statusMap);
          setPortfolioStatus(portfolioMap);
        } else {
          logger.error('Failed to fetch user watchlist for multiple tickers');
          const emptyStatus: Record<string, boolean> = {};
          tickerArray.forEach(t => {
            emptyStatus[t] = false;
          });
          setWatchlistStatus(emptyStatus);
          setPortfolioStatus(emptyStatus);
        }
      }

      // 2. Fetch consolidated data from /api/stock_data/{ticker}/get (supports multiple tickers)
      try {
        // Fetch data for each ticker from /api/stock_data/{ticker}/get
        const fetchPromises = tickerArray.map(async (t) => {
          try {
            const response = await fetch(`/api/stock_data/${t}`)

            if (response.ok) {
              const data = await response.json()
              const consolidated = data[t] || data;
              return {
                ticker: t,
                stock: consolidated.stock || { error: 'Missing stock data' },
                news: consolidated.news || { articles: [] },
                historical: consolidated.historical || { historicalData: [] },
                indicators: consolidated.indicators || null,
                earnings: consolidated.earnings || null,
                analyst: consolidated.analyst || null
              }
            } else if (response.status === 403) {
              // Handle 403 Forbidden (likely limit exceeded)
              const errorData = await response.json().catch(() => ({}))
              const errMsg = errorData.message || errorData.error || 'Access forbidden'
              return {
                ticker: t,
                limitExceeded: true,
                limitMessage: errMsg,
                stock: { error: 'Failed to fetch' },
                news: { articles: [] },
                historical: { historicalData: [] },
                indicators: null,
                earnings: null,
                analyst: null
              } as any
            } else {
              throw new Error(`Failed to fetch ${t}`)
            }
          } catch (err) {
            return {
              ticker: t,
              stock: { error: 'Failed to fetch' },
              news: { articles: [] },
              historical: { historicalData: [] },
              indicators: null,
              earnings: null,
              analyst: null
            }
          }
        })

        const results = await Promise.all(fetchPromises)

        // Check if any result failed due to limit exceeded
        const limitError = results.find(r => (r as any).limitExceeded)
        if (limitError) {
          const limitMsg = (limitError as any).limitMessage || 'Lookup limit exceeded';
          throw new Error(limitMsg)
        }

        const dataMap: Record<string, ConsolidatedStockData> = {}

        results.forEach(result => {
          dataMap[result.ticker] = {
            stock: result.stock || { error: 'Missing stock data' },
            news: result.news || { articles: [] },
            historical: result.historical || { historicalData: [] },
            indicators: result.indicators || null,
            earnings: result.earnings || null,
            analyst: result.analyst || null
          }
        })

        setStockDataMap(dataMap)
        setApiError(null)

        // Set earningsData for the single ticker view
        if (isSingleTicker) {
          const mainEarnings = results[0]?.earnings;
          if (mainEarnings) {
            setEarningsData(mainEarnings);
          } else {
            // Fallback fetch for earnings if not in consolidated
            try {
              const earningsRes = await fetch(`/api/stock_data/${primaryTicker}/earnings`);
              if (earningsRes.ok) {
                const earnings = await earningsRes.json();
                setEarningsData(earnings);
              }
            } catch (err) {
              logger.warn('Manual earnings fetch fallback failed', { error: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error('Failed to process stock data');
        logger.error('Stock data processing failed:', { error: error.message });

        const isLimitError = error.message.includes('limit') || error.message.includes('Lookup limit');
        setApiError({
          type: 'stock' as const,
          ticker: primaryTicker,
          message: isLimitError ? error.message : 'Network error while fetching stock data',
          details: isLimitError ? undefined : error.message,
          failedServices: ['API'],
        })
      }
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err : new Error('Network connection failed')

      logger.error('Stock fetch failed:', { error: error.message })

      setApiError({
        type: 'stock',
        ticker: primaryTicker,
        message: 'Network error while fetching stock data',
        details: error.message,
        failedServices: ['API'],
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (ticker) fetchStockData(ticker)
  }, [ticker])

  useEffect(() => {
    if (!isSingleTicker) return
    setGpsData(null)
    setGpsLoading(true)
    fetch(`/api/stock_data/${primaryTicker}/gps`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setGpsData(d))
      .catch(() => setGpsData(null))
      .finally(() => setGpsLoading(false))
  }, [primaryTicker, isSingleTicker])

  const handleWatchlistToggle = async (tickerToToggle: string) => {
    // Store previous state for rollback
    const previousWatchlistStatus = watchlistStatus[tickerToToggle];
    
    setAddingToWatchlist(true)
    setWatchlistSuccess(null)
    setWatchlistError(null)

    // Optimistic UI update
    setWatchlistStatus(prev => ({
      ...prev,
      [tickerToToggle]: !prev[tickerToToggle]
    }))

    try {
      let res
      if (previousWatchlistStatus) {
        // Remove from watchlist
        res = await fetch(`/api/user/watchlist?stockId=${tickerToToggle}`, {
          method: 'DELETE',
        })
      } else {
        // Add to watchlist
        const stockInfo = stockDataMap[tickerToToggle]?.stock
        res = await fetch('/api/user/watchlist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ticker: tickerToToggle,
            name: companyName || stockInfo?.name || tickerToToggle,
          }),
        })
      }

      const data = await res.json()

      if (res.ok) {
        setWatchlistSuccess(data.message)
      } else {
        // Rollback on error
        setWatchlistStatus(prev => ({
          ...prev,
          [tickerToToggle]: previousWatchlistStatus
        }))
        setWatchlistError(data.message || 'Failed to update watchlist.')
      }
    } catch (err: unknown) {
      // Rollback on error
      setWatchlistStatus(prev => ({
        ...prev,
        [tickerToToggle]: previousWatchlistStatus
      }))
      const error = err instanceof Error ? err : new Error('Network connection failed')
      setWatchlistError(error.message)
    } finally {
      setAddingToWatchlist(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64 flex-col mt-20">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div>
        <p className="ml-4 text-xl mt-20">Loading stock data...</p>
      </div>
    )
  }

  if (apiError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <ApiErrorDisplay error={apiError} />
      </div>
    )
  }

  if (Object.keys(stockDataMap).length === 0) {
    return (
      <div className="text-center p-8">
        <p className="text-gray-500">No stock data available</p>
      </div>
    )
  }

  // For single ticker
  if (isSingleTicker) {
    const data = stockDataMap[primaryTicker]
    if (!data) return null

    const stockData = data.stock
    
    // Handle news data - could be array or object with ticker keys
    let newsArray: any[] = []
    if (Array.isArray(data.news.articles)) {
      newsArray = data.news.articles
    } else if (typeof data.news.articles === 'object' && data.news.articles !== null) {
      newsArray = data.news.articles[primaryTicker] || []
    }
    const news = newsArray
    
    // Handle historical data - could be array or object with ticker keys
    let historicalArray: any[] = []
    if (Array.isArray(data.historical.historicalData)) {
      historicalArray = data.historical.historicalData
    } else if (typeof data.historical.historicalData === 'object' && data.historical.historicalData !== null) {
      historicalArray = data.historical.historicalData[primaryTicker] || []
    }
    const historical = historicalArray
    
    const indicators = data.indicators

    // currentPrice should prefer last, then close, then 0
    const currentPrice = stockData?.last || stockData?.close || 0

    return (
      <div className="container mx-auto px-0 py-8 max-w-6xl">
        <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
          {/* Company Title */}
          <div className="flex flex-col mb-4 text-center items-center gap-4">
            <h1 className="text-3xl font-bold text-gray-800">
              {stockData.name} ({stockData.symbol})
            </h1>
            {/* Watchlist Status/Button and Portfolio Badge */}
            <div className="flex gap-3 items-center">
              {portfolioStatus[primaryTicker] ? (
                <div className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-700 font-medium flex items-center gap-2">
                  <span>📊</span>
                  <span>In Portfolio</span>
                </div>
              ) : watchlistStatus[primaryTicker] ? (
                <button
                  onClick={() => handleWatchlistToggle(primaryTicker)}
                  disabled={addingToWatchlist}
                  style={{ backgroundColor: '#017e3b', borderColor: '#017e3b' }} className="px-4 py-2 rounded-md text-white hover:opacity-90 disabled:opacity-50 border"
                >
                  {addingToWatchlist ? 'Updating...' : 'Remove from Watchlist'}
                </button>
              ) : (
                <button
                  onClick={() => handleWatchlistToggle(primaryTicker)}
                  disabled={addingToWatchlist}
                  style={{ backgroundColor: '#017e3b' }} className="px-4 py-2 rounded-md text-white hover:opacity-90 disabled:opacity-50"
                >
                  {addingToWatchlist ? 'Adding...' : 'Add to Watchlist'}
                </button>
              )}
            </div>
          </div>

          {/* Company Description */}
          {stockData.longBusinessSummary && (
            <div className="mb-6"> {/* Added mb-6 for spacing */}
              <h2 className="text-2xl font-semibold text-gray-800 mb-4">📚 Company Overview</h2>
              <div className="text-gray-700 leading-relaxed">
                {showFullSummary || stockData.longBusinessSummary.length <= TRUNCATE_LENGTH
                  ? stockData.longBusinessSummary
                  : `${stockData.longBusinessSummary.substring(0, TRUNCATE_LENGTH)}...`}
                {stockData.longBusinessSummary.length > TRUNCATE_LENGTH && (
                  <button
                    onClick={() => setShowFullSummary(!showFullSummary)}
                    className="hover:text-green-800 ml-1 focus:outline-none" style={{ color: "#005a00" }}
                  >
                    {showFullSummary ? 'Read Less' : 'Read More'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Stock Info Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Last Price</p>
              <p className="text-2xl font-bold text-gray-800">{formatCurrency(currentPrice)}</p>
              {stockData.prevClose !== undefined && currentPrice !== null && (
                <p
                  className={`text-md ${
                    (currentPrice - stockData.prevClose) < 0
                      ? 'text-red-600'
                      : ''
                  }`}
                  style={(currentPrice - stockData.prevClose) >= 0 ? { color: "#005a00" } : {}}
                >
                  {formatNumber(currentPrice - stockData.prevClose)}{' '}
                  (
                  {formatNumber(
                    ((currentPrice - stockData.prevClose) / stockData.prevClose) *
                    100
                  )}
                  %)
                </p>
              )}
            </div>

            <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Open</p>
              <p className="text-2xl font-bold text-gray-800">{formatCurrency(stockData.open)}</p>
            </div>

            <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Volume</p>
              <p className="text-2xl font-bold text-gray-800">{formatNumber(stockData.volume, 0)}</p>
            </div>

            <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">P/E Ratio</p>
              <p className="text-2xl font-bold text-gray-800">{formatNumber(stockData.peRatio)}</p>
            </div>

            <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">P/B Ratio</p>
              <p className="text-2xl font-bold text-gray-800">{formatNumber(stockData.pbRatio)}</p>
            </div>

            <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Market Cap</p>
              <p className="text-2xl font-bold text-gray-800">{stockData.marketCap ? formatNumber(stockData.marketCap / 1_000_000_000) + 'B' : 'N/A'}</p>
            </div>
          </div>
          {watchlistSuccess && (
            <p className="mt-2 text-center" style={{ color: "#005a00" }}>{watchlistSuccess}</p>
          )}
          {watchlistError && (
            <p className="text-red-600 mt-2 text-center">{watchlistError}</p>
          )}
          </div>

          {/* Portfolio Position Section */}
          {portfolioStatus[primaryTicker] && portfolioData[primaryTicker] && portfolioData[primaryTicker].shares > 0 && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
            <h2 className="text-2xl font-semibold text-gray-800 mb-6 flex items-center gap-2">
              <span>💼</span> Your Portfolio Position
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-sm text-gray-500 uppercase font-medium mb-1">Total Portfolio Value</p>
                <p className="text-2xl font-bold text-gray-900">{formatCurrency(portfolioData[primaryTicker].shares * currentPrice)}</p>
                {portfolioData[primaryTicker].purchaseDate && (
                  <p className="text-xs text-gray-400 mt-2 text-gray-500">Current position value</p>
                )}
              </div>

              <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-sm text-gray-500 uppercase font-medium mb-1">Shares Owned</p>
                <p className="text-2xl font-bold text-gray-900">{formatNumber(portfolioData[primaryTicker].shares)}</p>
                {portfolioData[primaryTicker].purchaseDate && (
                  <p className="text-xs text-gray-400 mt-2 text-gray-500">First purchased on {formatDate(portfolioData[primaryTicker].purchaseDate)}</p>
                )}
              </div>

              <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-sm text-gray-500 uppercase font-medium mb-1">Today's Gain/Loss</p>
                {stockData.prevClose && currentPrice ? (
                  <>
                    <p className={`text-2xl font-bold ${(currentPrice - stockData.prevClose) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency((currentPrice - stockData.prevClose) * portfolioData[primaryTicker].shares)}
                    </p>
                    <p className={`text-xs mt-2 ${(currentPrice - stockData.prevClose) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {((currentPrice - stockData.prevClose) / stockData.prevClose * 100).toFixed(2)}% today
                    </p>
                  </>
                ) : (
                  <p className="text-2xl font-bold text-gray-400">N/A</p>
                )}
              </div>

              <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-sm text-gray-500 uppercase font-medium mb-1">Total Gain/Loss</p>
                {portfolioData[primaryTicker].purchasePrice > 0 ? (
                  <>
                    <p className={`text-2xl font-bold ${(currentPrice - portfolioData[primaryTicker].purchasePrice) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency((currentPrice - portfolioData[primaryTicker].purchasePrice) * portfolioData[primaryTicker].shares)}
                    </p>
                    <p className={`text-xs mt-2 ${(currentPrice - portfolioData[primaryTicker].purchasePrice) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {(((currentPrice - portfolioData[primaryTicker].purchasePrice) / portfolioData[primaryTicker].purchasePrice) * 100).toFixed(2)}% lifetime
                    </p>
                  </>
                ) : (
                  <p className="text-2xl font-bold text-gray-400">N/A</p>
                )}
              </div>
            </div>
          </div>
          )}

        <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
          <StockSignalPanel
            ticker={primaryTicker}
            gpsData={gpsData}
            gpsLoading={gpsLoading}
            onGeneratePrediction={() => predictionTriggerRef.current()}
            predictionLoading={predictionLoading}
          />

          <StockPrediction
            ticker={primaryTicker}
            currentPrice={currentPrice}
            peRatio={stockData?.peRatio}
            pbRatio={stockData?.pbRatio}
            marketCap={stockData?.marketCap}
            sma20={indicators?.sma20 ?? undefined}
            sma50={indicators?.sma50 ?? undefined}
            rsi={indicators?.rsi14 ?? undefined}
            momentum={indicators?.momentum ?? undefined}
            technicalScore={indicators?.scoreBreakdown?.totalScore}
            recommendationKey={data.analyst?.recommendationKey ?? null}
            newsArticles={news}
            historicalEarnings={earningsData?.historicalEarnings || []}
            titleLevel="h2"
            triggerRef={predictionTriggerRef}
            onLoadingChange={onPredictionLoadingChange}
            onPredictionComplete={refreshGps}
            embedded
          />
        </div>

        {/* Analyst Sentiment & Price Targets */}
        {data.analyst && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
            <h2 className="text-2xl font-semibold text-gray-800 mb-6">📊 Analyst Sentiment & Targets</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-4">
              {/* Recommendation Trend */}
              <div>
                <h3 className="text-xl font-medium text-gray-700 mb-4">Recommendation Trend</h3>
                {data.analyst.recommendationTrend && data.analyst.recommendationTrend.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                          <th className="px-2 py-2 text-center text-xs font-medium text-green-600 uppercase">Strong Buy</th>
                          <th className="px-2 py-2 text-center text-xs font-medium text-green-900 uppercase">Buy</th>
                          <th className="px-2 py-2 text-center text-xs font-medium text-yellow-500 uppercase">Hold</th>
                          <th className="px-2 py-2 text-center text-xs font-medium text-red-400 uppercase">Sell</th>
                          <th className="px-2 py-2 text-center text-xs font-medium text-red-600 uppercase">Strong Sell</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {data.analyst.recommendationTrend.slice(0, 4).map((trend, idx) => (
                          <tr key={idx} className={idx === 0 ? 'bg-blue-50 font-bold' : ''}>
                            <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{trend.period}</td>
                            <td className="px-2 py-2 whitespace-nowrap text-sm text-center text-gray-700">{trend.strongBuy}</td>
                            <td className="px-2 py-2 whitespace-nowrap text-sm text-center text-gray-700">{trend.buy}</td>
                            <td className="px-2 py-2 whitespace-nowrap text-sm text-center text-gray-700">{trend.hold}</td>
                            <td className="px-2 py-2 whitespace-nowrap text-sm text-center text-gray-700">{trend.sell}</td>
                            <td className="px-2 py-2 whitespace-nowrap text-sm text-center text-gray-700">{trend.strongSell}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-gray-500 italic">No recommendation trend data available.</p>
                )}
                <div className="mt-4 flex flex-col gap-1">
                   <p className="text-sm text-gray-600">
                    Consensus: <span className="font-bold text-gray-800 uppercase">{data.analyst.recommendationKey || 'N/A'}</span>
                  </p>
                  <p className="text-sm text-gray-600">
                    Based on <span className="font-bold text-gray-800">{data.analyst.numberOfAnalystOpinions || 0}</span> analyst opinions.
                  </p>
                </div>
              </div>

              {/* Price Targets */}
              <div>
                <h3 className="text-xl font-medium text-gray-700 mb-4">Price Targets</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase">Low Target</p>
                    <p className="text-lg font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.low)}</p>
                  </div>
                  <div className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase">High Target</p>
                    <p className="text-lg font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.high)}</p>
                  </div>
                  <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
                    <p className="text-xs text-blue-600 uppercase font-semibold">Mean Target</p>
                    <p className="text-lg font-bold text-blue-800">{formatCurrency(data.analyst.priceTarget.mean)}</p>
                  </div>
                  <div className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase">Median Target</p>
                    <p className="text-lg font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.median)}</p>
                  </div>
                </div>

                {data.analyst.priceTarget.mean && currentPrice && (
                  <div className="mt-6 p-4 rounded-xl border border-dashed border-gray-300">
                    <p className="text-sm text-gray-600 mb-1">Implied Upside/Downside (from Mean Target):</p>
                    <p className={`text-xl font-bold ${((data.analyst.priceTarget.mean - currentPrice) / currentPrice) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatNumber(((data.analyst.priceTarget.mean - currentPrice) / currentPrice) * 100)}%
                    </p>
                    <p className="text-xs text-gray-400 mt-2 italic">Calculated based on current price of {formatCurrency(currentPrice)}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Price History Chart */}
        {historical && historical.length > 0 && (
          <div className="mb-8">
            <StockChart ticker={primaryTicker} historicalData={historical} titleLevel="h2" />
          </div>
        )}

        {/* Technical Indicators */}
        {indicators && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">🎯 Technical Indicators & Trading Signal</h2>
            <TechnicalIndicatorsDisplay indicators={indicators} titleLevel="h3" />
          </div>
        )}

        {/* Earnings Information */}
        {earningsData && (earningsData.upcomingEarnings || earningsData.historicalEarnings.length > 0) && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">🗓️ Earnings Information</h2>

            {earningsData.upcomingEarnings && (
              <div className="mb-6">
                <h3 className="text-xl font-medium text-gray-700 mb-2">Upcoming Earnings:</h3>
                <p className="text-lg text-gray-900 font-bold">{earningsData.upcomingEarnings}</p>
              </div>
            )}

            {earningsData.historicalEarnings.length > 0 && (
              <div>
                <h3 className="text-xl font-medium text-gray-700 mb-4">Historical Earnings:</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                        <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">EPS Actual</th>
                        <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">EPS Estimate</th>
                        <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Revenue</th>
                        <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Earnings</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {earningsData.historicalEarnings.map((earning, index) => {
                        const actual = earning.epsActual;
                        const estimate = earning.epsEstimate;
                        let rowColorClass = 'text-gray-900'; // Default: dark gray

                        if (actual !== null && estimate !== null && actual !== undefined && estimate !== undefined && estimate !== 0) {
                          const surprisePct = ((actual - estimate) / Math.abs(estimate)) * 100;
                          if (surprisePct > 5) {
                            rowColorClass = 'text-green-700'; // Green for > 5% beat
                          } else if (surprisePct < -5) {
                            rowColorClass = 'text-red-600'; // Red for > 5% miss
                          }
                        }

                        return (
                          <tr key={index} className={`hover:bg-gray-50 font-medium ${rowColorClass}`}>
                            <td className="px-6 py-4 whitespace-nowrap text-sm">{formatDate(earning.date)}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-bold">{formatNumber(earning.epsActual)}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right">{formatNumber(earning.epsEstimate)}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right">{earning.revenue != null ? formatCurrency(earning.revenue / 1_000_000) + 'M' : 'N/A'}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right">{earning.earnings != null ? formatCurrency(earning.earnings / 1_000_000) + 'M' : 'N/A'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {earningsData.upcomingEarnings && (
                  <div className="mt-4 text-sm italic text-gray-700">Next Earnings Call : {earningsData.upcomingEarnings}</div>
                )}
              </div>
            )}
            {(!earningsData.upcomingEarnings && earningsData.historicalEarnings.length === 0) && (
              <p className="text-gray-500">No earnings data available for this stock.</p>
            )}
          </div>
        )}

        {/* News */}
        <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
          <StockNews articles={news} titleLevel="h2" />
        </div>
      </div>
    )
  }

  // For multiple tickers - show comparison view
  return (
    <div className="container mx-auto px-0 py-8 max-w-6xl">
      <h1 className="text-3xl font-bold text-gray-800 mb-8">Multi-Stock Comparison</h1>

      <div className="grid grid-cols-1 gap-8">
        {tickerArray.map(t => {
          const data = stockDataMap[t]
          if (!data) return null

          const stockData = data.stock
          
          // Handle news data - could be array or object with ticker keys
          let newsArray: any[] = []
          if (Array.isArray(data.news.articles)) {
            newsArray = data.news.articles
          } else if (typeof data.news.articles === 'object' && data.news.articles !== null) {
            newsArray = data.news.articles[t] || []
          }
          const news = newsArray
          
          // Handle historical data - could be array or object with ticker keys
          let historicalArray: any[] = []
          if (Array.isArray(data.historical.historicalData)) {
            historicalArray = data.historical.historicalData
          } else if (typeof data.historical.historicalData === 'object' && data.historical.historicalData !== null) {
            historicalArray = data.historical.historicalData[t] || []
          }
          const historical = historicalArray
          
          const indicators = data.indicators
          const currentPrice = stockData?.last || stockData?.close || 0

          return (
            <div key={t} className="border-t-2 border-gray-200 pt-8">
              {/* Stock Info */}
              <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-6">
                <div className="flex flex-col mb-6 md:flex-row md:items-center md:justify-between gap-7">
                  <h2 className="text-2xl font-bold text-gray-800">
                    {stockData.name} ({stockData.symbol})
                  </h2>
                  <div className="flex gap-3 items-center">
                    {portfolioStatus[t] ? (
                      <div className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-700 font-medium flex items-center gap-2">
                        <span>📊</span>
                        <span>In Portfolio</span>
                      </div>
                    ) : watchlistStatus[t] ? (
                      <button
                        onClick={() => handleWatchlistToggle(t)}
                        disabled={addingToWatchlist}
                        style={{ backgroundColor: '#017e3b', borderColor: '#017e3b' }} className="px-4 py-2 rounded-md text-white hover:opacity-90 disabled:opacity-50 border"
                      >
                        {addingToWatchlist ? 'Updating...' : 'Remove from Watchlist'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleWatchlistToggle(t)}
                        disabled={addingToWatchlist}
                        style={{ backgroundColor: '#017e3b' }} className="px-4 py-2 rounded-md text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {addingToWatchlist ? 'Adding...' : 'Add to Watchlist'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
                    <p className="text-sm text-gray-500">Last Price</p>
                    <p className="text-2xl font-bold text-gray-800">{formatCurrency(currentPrice)}</p>
                  </div>

                  <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
                    <p className="text-sm text-gray-500">P/E Ratio</p>
                    <p className="text-2xl font-bold text-gray-800">{formatNumber(stockData.peRatio)}</p>
                  </div>

                  <div className="p-4 bg-gray-50 rounded-lg border border-[#e9ede8]">
                    <p className="text-sm text-gray-500">Market Cap</p>
                    <p className="text-2xl font-bold text-gray-800">{stockData.marketCap ? formatNumber(stockData.marketCap / 1_000_000_000) + 'B' : 'N/A'}</p>
                  </div>
                </div>
              </div>

              {/* Chart */}
              {historical && historical.length > 0 && (
                <div className="mb-6">
                  <StockChart ticker={t} historicalData={historical} titleLevel="h3" />
                </div>
              )}

              {/* Prediction */}
              <StockPrediction
                ticker={t}
                currentPrice={currentPrice}
                peRatio={stockData?.peRatio}
                pbRatio={stockData?.pbRatio}
                marketCap={stockData?.marketCap}
                sma20={indicators?.sma20 ?? undefined}
                sma50={indicators?.sma50 ?? undefined}
                rsi={indicators?.rsi14 ?? undefined}
                momentum={indicators?.momentum ?? undefined}
                technicalScore={indicators?.scoreBreakdown?.totalScore}
                recommendationKey={data.analyst?.recommendationKey ?? null}
                newsArticles={news}
                titleLevel="h3"
              />

              {/* Analyst Sentiment & Price Targets */}
              {data.analyst && (
                <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-6">
                  <h3 className="text-xl font-semibold text-gray-800 mb-6">📊 Analyst Sentiment & Targets</h3>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-4">
                    {/* Recommendation Trend */}
                    <div>
                      <h4 className="text-lg font-medium text-gray-700 mb-4">Recommendation Trend</h4>
                      {data.analyst.recommendationTrend && data.analyst.recommendationTrend.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                                <th className="px-1 py-2 text-center text-xs font-medium text-green-600 uppercase">Buy</th>
                                <th className="px-1 py-2 text-center text-xs font-medium text-yellow-500 uppercase">Hold</th>
                                <th className="px-1 py-2 text-center text-xs font-medium text-red-600 uppercase">Sell</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {data.analyst.recommendationTrend.slice(0, 3).map((trend, idx) => (
                                <tr key={idx} className={idx === 0 ? 'bg-blue-50 font-bold' : ''}>
                                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900">{trend.period}</td>
                                  <td className="px-1 py-2 whitespace-nowrap text-xs text-center text-gray-700">{trend.strongBuy + trend.buy}</td>
                                  <td className="px-1 py-2 whitespace-nowrap text-xs text-center text-gray-700">{trend.hold}</td>
                                  <td className="px-1 py-2 whitespace-nowrap text-xs text-center text-gray-700">{trend.sell + trend.strongSell}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-gray-500 italic text-sm">No recommendation data.</p>
                      )}
                      <div className="mt-3">
                        <p className="text-xs text-gray-600">
                          Consensus: <span className="font-bold text-gray-800 uppercase">{data.analyst.recommendationKey || 'N/A'}</span>
                        </p>
                      </div>
                    </div>

                    {/* Price Targets */}
                    <div>
                      <h4 className="text-lg font-medium text-gray-700 mb-4">Price Targets</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-2 bg-gray-50 rounded-lg border border-gray-100">
                          <p className="text-[10px] text-gray-500 uppercase">Low</p>
                          <p className="text-md font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.low)}</p>
                        </div>
                        <div className="p-2 bg-gray-50 rounded-lg border border-gray-100">
                          <p className="text-[10px] text-gray-500 uppercase">High</p>
                          <p className="text-md font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.high)}</p>
                        </div>
                        <div className="p-2 bg-blue-50 rounded-lg border border-blue-100 col-span-2">
                          <div className="flex justify-between items-center">
                            <div>
                              <p className="text-[10px] text-blue-600 uppercase font-semibold">Mean Target</p>
                              <p className="text-lg font-bold text-blue-800">{formatCurrency(data.analyst.priceTarget.mean)}</p>
                            </div>
                            {data.analyst.priceTarget.mean && currentPrice && (
                              <div className="text-right">
                                <p className="text-[10px] text-gray-500 uppercase">Potential</p>
                                <p className={`text-md font-bold ${((data.analyst.priceTarget.mean - currentPrice) / currentPrice) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                  {formatNumber(((data.analyst.priceTarget.mean - currentPrice) / currentPrice) * 100)}%
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Indicators */}
              {indicators && (
                <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-6">
                  <h3 className="text-xl font-semibold text-gray-800 mb-4">🎯 Technical Indicators</h3>
                  <TechnicalIndicatorsDisplay indicators={indicators} titleLevel="h4" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
