'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { TechnicalIndicators } from '@/utils/technicalIndicators'
import { getVolatilityRating } from '@/utils/volatility'
import ApiErrorDisplay, { ApiError } from './ApiErrorDisplay'
import TechnicalIndicatorsDisplay from './TechnicalIndicatorsDisplay'
import StockChart from './StockChart'
import StockNews from './StockNews'
import { createLogger } from '@/utils/logger'
import StockPrediction from './StockPrediction'
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

interface ConsolidatedStockData {
  stock: StockData
  news: any
  historical: any
  indicators: TechnicalIndicators | null
  earnings: EarningsData | null // Add earnings data
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
  const [earningsData, setEarningsData] = useState<EarningsData | null>(null);
  const [showFullSummary, setShowFullSummary] = useState(false); // State for showing full summary
  const TRUNCATE_LENGTH = 300; // Define truncation length

  const router = useRouter()

  // Normalize tickers
  const tickerArray = ticker.split(',').map(t => t.trim().toUpperCase())
  const isSingleTicker = tickerArray.length === 1
  const primaryTicker = tickerArray[0]

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
          const { onWatchlist, onPortfolio } = await watchlistRes.json();
          // If stock is in portfolio, treat it as on watchlist
          const effectiveWatchlistStatus = onWatchlist || onPortfolio;
          setWatchlistStatus({ [primaryTicker]: effectiveWatchlistStatus });
          setPortfolioStatus({ [primaryTicker]: onPortfolio });
        } else {
          logger.error('Failed to fetch single stock watchlist status');
          setWatchlistStatus({ [primaryTicker]: false });
          setPortfolioStatus({ [primaryTicker]: false });
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

      // 2. Fetch consolidated data from /api/stock/{ticker}/get (supports multiple tickers)
      try {
        // Fetch data for each ticker from /api/stock/{ticker}/get
        const fetchPromises = tickerArray.map(async (t) => {
          try {
            const res = await fetch(`/api/stock/${t}`)
            if (res.ok) {
              const data = await res.json()
              return {
                ticker: t,
                stock: data.stock || {},
                news: data.news || {},
                historical: data.historical || {},
                indicators: data.indicators || null
              }
            } else {
              throw new Error(`Failed to fetch ${t}`)
            }
          } catch (err) {
            return {
              ticker: t,
              stock: { error: 'Failed to fetch' },
              news: { articles: {} },
              historical: { historicalData: {} },
              indicators: null
            }
          }
        })

        const results = await Promise.all(fetchPromises)
        const dataMap: Record<string, ConsolidatedStockData> = {}
        
        results.forEach(result => {
          dataMap[result.ticker] = {
            stock: result.stock,
            news: result.news,
            historical: result.historical,
            indicators: result.indicators,
            earnings: null // Initialize earnings to null here
          }
        })
        
        setStockDataMap(dataMap)
        setApiError(null)

        // Fetch earnings data separately if single ticker
        if (isSingleTicker) {
          try {
            const earningsRes = await fetch(`/api/stock/${primaryTicker}/earnings`);
            if (earningsRes.ok) {
              const earnings = await earningsRes.json();
              setEarningsData(earnings);
            } else {
              logger.error('Failed to fetch earnings data for single ticker');
            }
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error('Error fetching earnings data for single ticker:', error);
          }
        }
      } catch (err: unknown) {
        // Fallback: call individual endpoints
        logger.warn('Consolidated endpoint failed, falling back to individual endpoints')
        const dataMap: Record<string, ConsolidatedStockData> = {}

        for (const t of tickerArray) {
          try {
            const [stockRes, newsRes, histRes, earningsRes] = await Promise.all([
              fetch(`/api/stock/${t}`),
              fetch(`/api/stock/${t}/news`),
              fetch(`/api/stock/${t}/historical/1y`),
              fetch(`/api/stock/${t}/earnings`) // Fetch earnings data
            ])

            const stock = stockRes.ok ? await stockRes.json() : {}
            const newsJson = newsRes.ok ? await newsRes.json() : {}
            const histJson = histRes.ok ? await histRes.json() : {}
            const earningsJson = earningsRes.ok ? await earningsRes.json() : null // Fetch earnings

            // Handle array response from quote endpoint
            const stockData = Array.isArray(stock) ? stock[0] : stock

            // Extract news articles for this ticker
            const newsArticles = newsJson.articles?.[t] || newsJson.articles || []

            // Extract historical data for this ticker
            const historicalData = histJson.historicalData?.[t] || histJson.historicalData || []

            dataMap[t] = {
              stock: stockData || { error: 'Failed to fetch stock data' },
              news: { articles: newsArticles, source: newsJson.source },
              historical: { historicalData, source: histJson.source },
              indicators: null, // Would need to calculate if needed
              earnings: earningsJson // Include earnings data
            }
          } catch (tickerErr: unknown) {
            const e = tickerErr instanceof Error ? tickerErr : new Error(String(tickerErr))
            logger.error(`Failed to fetch data for ${t}:`, e)
            dataMap[t] = {
              stock: { error: 'Network error' },
              news: { articles: [] },
              historical: { historicalData: [] },
              indicators: null,
              earnings: null
            }
          }
        }

        setStockDataMap(dataMap)
      }
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err : new Error('Network connection failed')

      logger.error('Stock fetch failed:', error)

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
                  className="px-4 py-2 rounded-md text-white bg-green-700 hover:bg-green-800 disabled:opacity-50 border border-green-700"
                >
                  {addingToWatchlist ? 'Updating...' : 'Remove from Watchlist'}
                </button>
              ) : (
                <button
                  onClick={() => handleWatchlistToggle(primaryTicker)}
                  disabled={addingToWatchlist}
                  className="px-4 py-2 rounded-md text-white bg-green-700 hover:bg-green-800 disabled:opacity-50"
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
                    className="text-blue-600 hover:text-blue-800 font-semibold ml-1 focus:outline-none"
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
                    (currentPrice - stockData.prevClose) >= 0
                      ? 'text-green-600'
                      : 'text-red-600'
                  }`}
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
            <p className="text-green-600 mt-2 text-center">{watchlistSuccess}</p>
          )}
          {watchlistError && (
            <p className="text-red-600 mt-2 text-center">{watchlistError}</p>
          )}
        </div>

        {/* Price History Chart */}
        {historical && historical.length > 0 && (
          <div className="mb-8">
            <StockChart ticker={primaryTicker} historicalData={historical} />
          </div>
        )}

        {/* 1-Year Price Prediction */}
        {historical && historical.length > 0 && (
          <StockPrediction
            ticker={primaryTicker}
            currentPrice={currentPrice}
            historicalData={historical}
            peRatio={stockData?.peRatio}
            pbRatio={stockData?.pbRatio}
            marketCap={stockData?.marketCap}
            sma20={indicators?.sma20 ?? undefined}
            sma50={indicators?.sma50 ?? undefined}
            rsi={indicators?.rsi14 ?? undefined}
            momentum={indicators?.momentum ?? undefined}
            newsArticles={news}
            historicalEarnings={earningsData?.historicalEarnings || []}
          />
        )}

        {/* Technical Indicators */}
        {indicators && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">🎯 Technical Indicators & Trading Signal</h2>
            <TechnicalIndicatorsDisplay indicators={indicators} />
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
                      {earningsData.historicalEarnings.map((earning, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{formatDate(earning.date)}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{formatNumber(earning.epsActual)}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{formatNumber(earning.epsEstimate)}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{earning.revenue != null ? formatCurrency(earning.revenue / 1_000_000) + 'M' : 'N/A'}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{earning.earnings != null ? formatCurrency(earning.earnings / 1_000_000) + 'M' : 'N/A'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {(!earningsData.upcomingEarnings && earningsData.historicalEarnings.length === 0) && (
              <p className="text-gray-500">No earnings data available for this stock.</p>
            )}
          </div>
        )}

        {/* News */}
        <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
          <StockNews articles={news} />
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
                        className="px-4 py-2 rounded-md text-white bg-green-700 hover:bg-green-800 disabled:opacity-50 border border-green-700"
                      >
                        {addingToWatchlist ? 'Updating...' : 'Remove from Watchlist'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleWatchlistToggle(t)}
                        disabled={addingToWatchlist}
                        className="px-4 py-2 rounded-md text-white bg-green-700 hover:bg-green-800 disabled:opacity-50"
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
                  <StockChart ticker={t} historicalData={historical} />
                </div>
              )}

              {/* Prediction */}
              {historical && historical.length > 0 && (
                <StockPrediction
                  ticker={t}
                  currentPrice={currentPrice}
                  historicalData={historical}
                  peRatio={stockData?.peRatio}
                  pbRatio={stockData?.pbRatio}
                  marketCap={stockData?.marketCap}
                  sma20={indicators?.sma20 ?? undefined}
                  sma50={indicators?.sma50 ?? undefined}
                  rsi={indicators?.rsi14 ?? undefined}
                  momentum={indicators?.momentum ?? undefined}
                  newsArticles={news}
                />
              )}

              {/* Indicators */}
              {indicators && (
                <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-6">
                  <h3 className="text-xl font-semibold text-gray-800 mb-4">🎯 Technical Indicators</h3>
                  <TechnicalIndicatorsDisplay indicators={indicators} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
