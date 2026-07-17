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
import SymbolAccuracyIndicator from './SymbolAccuracyIndicator'
import BuyMoreModal from './modals/BuyMoreModal'
import SellModal from './modals/SellModal'
import RsuVestModal from './modals/RsuVestModal'
import PurchaseFromWatchlistModal from './modals/PurchaseFromWatchlistModal'
import { formatNumber, formatCurrency } from '@/utils/formatters' // Added import
import { computeAnalystGrade, gradeColor } from '@/utils/analystGrade'

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
  sector?: string
  industry?: string
  quoteType?: string
  longBusinessSummary?: string
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

interface EtfHoldingRow {
  ticker: string;
  companyName: string;
  holdingPercent: number;
  gps_score: number | null;
  gps_breakdown: any | null;
  score_source: string | null;
  surfaced: boolean;
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
  const [portfolioData, setPortfolioData] = useState<Record<string, { stockId: number | null; shares: number; purchaseDate: string | null; purchasePrice: number }>>({})
  const [watchlistData, setWatchlistData] = useState<Record<string, { addedDate: string | null; priceAdded: number }>>({})
  const [manageAction, setManageAction] = useState<'buy' | 'sell' | 'rsu_vest' | null>(null)
  const [showBuyFromWatchlist, setShowBuyFromWatchlist] = useState(false)
  const [earningsData, setEarningsData] = useState<EarningsData | null>(null);
  const [showFullSummary, setShowFullSummary] = useState(false); // State for showing full summary
  const TRUNCATE_LENGTH = 300; // Define truncation length

  const [gpsData, setGpsData] = useState<GpsData | null>(null)
  const [gpsLoading, setGpsLoading] = useState(false)
  const [predictionLoading, setPredictionLoading] = useState(false)
  const [etfHoldings, setEtfHoldings] = useState<EtfHoldingRow[] | null>(null)
  const [etfHoldingsLoading, setEtfHoldingsLoading] = useState(false)
  const [prefetchedPrediction, setPrefetchedPrediction] = useState<any | null>(null)
  const [prefetchedPredictionAt, setPrefetchedPredictionAt] = useState<string | null>(null)
  const predictionTriggerRef = useRef<() => void>(() => {})
  const onPredictionLoadingChange = useCallback((v: boolean) => setPredictionLoading(v), [])

  const router = useRouter()

  // Normalize tickers
  const tickerArray = ticker.split(',').map(t => t.trim().toUpperCase())
  const isSingleTicker = tickerArray.length === 1
  const primaryTicker = tickerArray[0]

  const refreshGps = useCallback((freshGps?: GpsData | null) => {
    if (freshGps !== undefined) {
      setGpsData(freshGps)
      return
    }
    if (!isSingleTicker) return
    setGpsLoading(true)
    fetch(`/api/stock_data/${primaryTicker}/gps`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setGpsData(d))
      .catch(() => {})
      .finally(() => setGpsLoading(false))
  }, [primaryTicker, isSingleTicker])

  // A fresh regenerate wrote a new prediction_records row (browser flow, see
  // api/prediction/[ticker]/route.ts). Stamp the age to now so the footnote
  // reads "just now" — this is only called on success.
  const handlePredictionSuccess = useCallback((freshGps?: GpsData | null) => {
    refreshGps(freshGps)
    setPrefetchedPredictionAt(new Date().toISOString())
  }, [refreshGps])

  // Regeneration failed. Clear the prefetched footprint so the UI stops
  // claiming "Showing prediction from latest batch run" — that would be a lie
  // since the panel is now showing an error, not a prediction. Also flips the
  // signal-panel button label from "Regenerate Prediction" back to "Show
  // prediction details."
  const handlePredictionFailure = useCallback(() => {
    setPrefetchedPredictionAt(null)
    setPrefetchedPrediction(null)
  }, [])

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
          const { stockId, onWatchlist, onPortfolio, shares, purchaseDate, purchasePrice, watchlistAddedDate, watchlistPriceAdded } = await watchlistRes.json();
          // If stock is in portfolio, treat it as on watchlist
          const effectiveWatchlistStatus = onWatchlist || onPortfolio;
          setWatchlistStatus({ [primaryTicker]: effectiveWatchlistStatus });
          setPortfolioStatus({ [primaryTicker]: onPortfolio });
          setPortfolioData({ [primaryTicker]: { stockId: stockId ?? null, shares, purchaseDate, purchasePrice } });
          setWatchlistData({ [primaryTicker]: { addedDate: watchlistAddedDate ?? null, priceAdded: Number(watchlistPriceAdded) || 0 } });
        } else {
          logger.error('Failed to fetch single stock watchlist status');
          setWatchlistStatus({ [primaryTicker]: false });
          setPortfolioStatus({ [primaryTicker]: false });
          setPortfolioData({ [primaryTicker]: { stockId: null, shares: 0, purchaseDate: null, purchasePrice: 0 } });
          setWatchlistData({ [primaryTicker]: { addedDate: null, priceAdded: 0 } });
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

  // The auto-timestamp-on-loading-transition effect used to live here. It
  // fired on ANY loading true→false, including failure, which lied about
  // "Showing prediction from latest batch run — just now" when the regenerate
  // had actually crashed. The timestamp is now updated via the success
  // callback (handlePredictionSuccess) and cleared via the failure callback
  // (handlePredictionFailure) — see below.

  useEffect(() => {
    if (!isSingleTicker) return
    setPrefetchedPrediction(null)
    setPrefetchedPredictionAt(null)
    fetch(`/api/stock_data/${primaryTicker}/latest-prediction`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setPrefetchedPrediction(d?.prediction ?? null)
        setPrefetchedPredictionAt(d?.createdAt ?? null)
      })
      .catch(() => {
        setPrefetchedPrediction(null)
        setPrefetchedPredictionAt(null)
      })
  }, [primaryTicker, isSingleTicker])

  useEffect(() => {
    if (!isSingleTicker) return
    const stockData = stockDataMap[primaryTicker]?.stock
    if (!stockData || stockData.quoteType?.toUpperCase() !== 'ETF') return
    setEtfHoldings(null)
    setEtfHoldingsLoading(true)
    fetch(`/api/stock_data/${primaryTicker}/holdings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setEtfHoldings(d?.holdings ?? null))
      .catch(() => setEtfHoldings(null))
      .finally(() => setEtfHoldingsLoading(false))
  }, [primaryTicker, isSingleTicker, stockDataMap])

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

    const analystGrade = computeAnalystGrade(
      data.analyst?.recommendationTrend,
      data.analyst?.priceTarget,
      currentPrice || null,
    )

    return (
      <div className="container mx-auto px-0 py-8 max-w-6xl">
        {/* Title card — sector tag + name. When the ticker is neither in
            portfolio nor on watchlist, the add-to-watchlist button sits here.
            Portfolio/watchlist state is conveyed by their own dedicated
            sections below. */}
        <div className="relative bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 pt-10 section-title-card">
          {(() => {
            const isEtf = stockData.quoteType?.toUpperCase() === 'ETF'
            const label = isEtf ? 'ETF' : stockData.industry || stockData.sector || null
            if (!label) return null
            return (
              <span className="absolute top-0 left-0 inline-flex items-center gap-1.5 bg-[#017e3b] text-white text-[11px] font-bold px-2.5 py-1 rounded-tl-2xl rounded-br-md">
                {label}
              </span>
            )
          })()}
          <div className="flex flex-col mb-4 text-center items-center gap-4">
            <h1 className="text-3xl font-bold text-gray-800">
              {stockData.name} ({stockData.symbol})
            </h1>
            {!portfolioStatus[primaryTicker] && !watchlistStatus[primaryTicker] && (
              <button
                onClick={() => handleWatchlistToggle(primaryTicker)}
                disabled={addingToWatchlist}
                className="px-4 py-2 rounded-md text-white hover:opacity-90 disabled:opacity-50 bg-[#017e3b]"
              >
                {addingToWatchlist ? 'Adding...' : 'Add to Watchlist'}
              </button>
            )}
          </div>
          {watchlistSuccess && (
            <p className="mt-2 text-center text-[#005a00]">{watchlistSuccess}</p>
          )}
          {watchlistError && (
            <p className="text-red-600 mt-2 text-center">{watchlistError}</p>
          )}
        </div>

        {/* Overview card — company summary + key stats */}
        <div className="relative bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 pt-10 section-company-overview">
          {stockData.longBusinessSummary && (
            <div className="mb-6">
              <h2 className="section-heading">Company Overview</h2>
              <div className="text-gray-700 leading-relaxed">
                {showFullSummary || stockData.longBusinessSummary.length <= TRUNCATE_LENGTH
                  ? stockData.longBusinessSummary
                  : `${stockData.longBusinessSummary.substring(0, TRUNCATE_LENGTH)}...`}
                {stockData.longBusinessSummary.length > TRUNCATE_LENGTH && (
                  <button
                    onClick={() => setShowFullSummary(!showFullSummary)}
                    className="hover:text-green-800 ml-1 focus:outline-none text-[#005a00]"
                  >
                    {showFullSummary ? 'Read Less' : 'Read More'}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Last Price</p>
              <p className="text-2xl font-bold text-gray-800">{formatCurrency(currentPrice)}</p>
              {stockData.prevClose !== undefined && currentPrice !== null && (
                <p
                  className={`text-md ${
                    (currentPrice - stockData.prevClose) < 0
                      ? 'text-red-600'
                      : 'text-[#005a00]'
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

            <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Open</p>
              <p className="text-2xl font-bold text-gray-800">{formatCurrency(stockData.open)}</p>
            </div>

            <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Volume</p>
              <p className="text-2xl font-bold text-gray-800">{formatNumber(stockData.volume, 0)}</p>
            </div>

            <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">P/E Ratio</p>
              <p className={`text-2xl font-bold ${typeof stockData.peRatio === 'number' && stockData.peRatio < 0 ? 'text-red-600' : 'text-gray-800'}`}>
                {formatNumber(stockData.peRatio)}
              </p>
            </div>

            <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">P/B Ratio</p>
              <p className={`text-2xl font-bold ${typeof stockData.pbRatio === 'number' && stockData.pbRatio < 0 ? 'text-red-600' : 'text-gray-800'}`}>
                {formatNumber(stockData.pbRatio)}
              </p>
            </div>

            <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
              <p className="text-sm text-gray-500">Market Cap</p>
              <p className="text-2xl font-bold text-gray-800">{stockData.marketCap ? formatNumber(stockData.marketCap / 1_000_000_000) + 'B' : 'N/A'}</p>
            </div>
          </div>
        </div>

          {/* Portfolio Position Section */}
          {portfolioStatus[primaryTicker] && portfolioData[primaryTicker] && portfolioData[primaryTicker].shares > 0 && (() => {
            const pos = portfolioData[primaryTicker]
            const positionValue = pos.shares * currentPrice
            const todayPct = stockData.prevClose && currentPrice
              ? ((currentPrice - stockData.prevClose) / stockData.prevClose) * 100
              : null
            const todayDollar = stockData.prevClose && currentPrice
              ? (currentPrice - stockData.prevClose) * pos.shares
              : null
            const todayPositive = todayDollar != null && todayDollar >= 0
            const totalGainPct = pos.purchasePrice > 0
              ? ((currentPrice - pos.purchasePrice) / pos.purchasePrice) * 100
              : null
            const totalGainDollar = pos.purchasePrice > 0
              ? (currentPrice - pos.purchasePrice) * pos.shares
              : null
            const totalPositive = totalGainDollar != null && totalGainDollar >= 0

            // Day-over-day close behavior since first_purchase_date. Two metrics:
            //   1) current streak — how many consecutive days the stock has been
            //      moving in one direction as of the most recent close. Reported
            //      as a count + direction ('up' | 'down' | 'flat'). 'flat' means
            //      the latest close equals the prior close — the streak broke.
            //   2) total up/down days — running tally of every up-close and
            //      every down-close since purchase. NOT consecutive.
            // Equal closes break the current streak but do not increment either
            // total. The prior close used as the baseline for day-1 may pre-date
            // the purchase — that's fine, it's the comparison anchor.
            const streaks = (() => {
              const empty = { current: 0, currentDirection: 'flat' as 'up' | 'down' | 'flat', totalUp: 0, totalDown: 0 }
              if (!pos.purchaseDate || !Array.isArray(historical) || historical.length < 2) return empty
              const purchaseTime = new Date(pos.purchaseDate).getTime()
              if (Number.isNaN(purchaseTime)) return empty
              let totalUp = 0, totalDown = 0
              let current = 0
              let currentDirection: 'up' | 'down' | 'flat' = 'flat'
              for (let i = 1; i < historical.length; i++) {
                const row = historical[i]
                const prevRow = historical[i - 1]
                const rowTime = new Date(row?.date).getTime()
                if (Number.isNaN(rowTime) || rowTime < purchaseTime) continue
                const curr = row?.close
                const prev = prevRow?.close
                if (typeof curr !== 'number' || typeof prev !== 'number') continue
                if (curr > prev) {
                  totalUp += 1
                  current = currentDirection === 'up' ? current + 1 : 1
                  currentDirection = 'up'
                } else if (curr < prev) {
                  totalDown += 1
                  current = currentDirection === 'down' ? current + 1 : 1
                  currentDirection = 'down'
                } else {
                  current = 0
                  currentDirection = 'flat'
                }
              }
              return { current, currentDirection, totalUp, totalDown }
            })()

            return (
              <div className="bg-white rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] border border-gray-100 mb-8 p-8 pb-7 section-your-portfolio-position">
                <h2 className="section-heading">Your Portfolio Position</h2>

                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4 flex flex-col">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Total Portfolio Value</p>
                    <div className="mt-auto">
                      <p className="text-xl font-bold text-gray-900 leading-tight mb-1">{formatCurrency(positionValue)}</p>
                      <p className="text-xs text-gray-500">Current position value</p>
                    </div>
                  </div>

                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4 flex flex-col">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Shares Owned</p>
                    <div className="mt-auto">
                      <p className="text-xl font-bold text-gray-900 leading-tight mb-1">{formatNumber(pos.shares)}</p>
                      <p className="text-xs text-gray-500">
                        {pos.purchaseDate ? `Prchased on ${formatDate(pos.purchaseDate)}` : ' '}
                      </p>
                    </div>
                  </div>

                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4 flex flex-col">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Today's Gain/Loss</p>
                    <div className="mt-auto">
                      {todayDollar != null && todayPct != null ? (
                        <>
                          <p className={`text-xl font-bold leading-tight mb-1 ${todayPositive ? 'text-green-700' : 'text-red-600'}`}>
                            {formatCurrency(todayDollar)}
                          </p>
                          <p className={`text-xs ${todayPositive ? 'text-green-700' : 'text-red-600'}`}>
                            {todayPct.toFixed(2)}% today
                          </p>
                        </>
                      ) : (
                        <p className="text-xl font-bold text-gray-400 leading-tight">N/A</p>
                      )}
                    </div>
                  </div>

                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4 flex flex-col">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Total Gain/Loss</p>
                    <div className="mt-auto">
                      {totalGainDollar != null && totalGainPct != null ? (
                        <>
                          <p className={`text-xl font-bold leading-tight mb-1 ${totalPositive ? 'text-green-700' : 'text-red-600'}`}>
                            {formatCurrency(totalGainDollar)}
                          </p>
                          <p className={`text-xs ${totalPositive ? 'text-green-700' : 'text-red-600'}`}>
                            {totalGainPct.toFixed(2)}% lifetime
                          </p>
                        </>
                      ) : (
                        <p className="text-xl font-bold text-gray-400 leading-tight">N/A</p>
                      )}
                    </div>
                  </div>

                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4 flex flex-col">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Streaks</p>
                    <div className="mt-auto">
                      {streaks.totalUp === 0 && streaks.totalDown === 0 ? (
                        <>
                          <p className="text-xl font-bold text-gray-400 leading-tight mb-1">—</p>
                          <p className="text-xs text-gray-500">No streak data yet</p>
                        </>
                      ) : (
                        <>
                          <p className={`text-base font-bold leading-tight ${
                            streaks.currentDirection === 'up' ? 'text-green-700'
                            : streaks.currentDirection === 'down' ? 'text-red-600'
                            : 'text-gray-500'
                          }`}>
                            {streaks.currentDirection === 'flat'
                              ? '0 current'
                              : `${streaks.current} current ${streaks.currentDirection}`}
                          </p>
                          <p className="text-base font-bold text-green-700 leading-tight">
                            {streaks.totalUp} up days
                          </p>
                          <p className="text-base font-bold text-red-600 leading-tight">
                            {streaks.totalDown} down days
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="h-px bg-gray-200 mb-5" />

                <div className="flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-2.5">
                  <span className="text-xs text-gray-500 font-medium sm:mr-1">Manage position</span>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setManageAction('buy')}
                      disabled={pos.stockId == null}
                      className="inline-flex items-center gap-1.5 px-3 sm:px-5 py-2 rounded-md text-[13px] font-semibold whitespace-nowrap bg-green-700 text-white border-[1.5px] border-green-700 hover:bg-green-800 hover:border-green-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                        <line x1="12" y1="5" x2="12" y2="19" strokeLinecap="round" />
                        <line x1="5" y1="12" x2="19" y2="12" strokeLinecap="round" />
                      </svg>
                      Buy more
                    </button>
                    <button
                      type="button"
                      onClick={() => setManageAction('sell')}
                      disabled={pos.stockId == null}
                      className="inline-flex items-center gap-1.5 px-3 sm:px-5 py-2 rounded-md text-[13px] font-semibold whitespace-nowrap bg-white text-green-700 border-[1.5px] border-green-700 hover:bg-green-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                        <line x1="5" y1="12" x2="19" y2="12" strokeLinecap="round" />
                      </svg>
                      Sell shares
                    </button>
                    <button
                      type="button"
                      onClick={() => setManageAction('rsu_vest')}
                      disabled={pos.stockId == null}
                      className="inline-flex items-center gap-1.5 px-3 sm:px-5 py-2 rounded-md text-[13px] font-semibold whitespace-nowrap bg-white text-blue-700 border-[1.5px] border-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      RSU vest
                    </button>
                  </div>
                  {pos.purchaseDate && (
                    <span className="text-xs text-gray-500 font-medium sm:ml-auto">
                      Position opened {formatDate(pos.purchaseDate)}
                    </span>
                  )}
                </div>
              </div>
            )
          })()}

          {/* Your Watchlist Section — shown when ticker is on watchlist but NOT yet in portfolio */}
          {!portfolioStatus[primaryTicker] && watchlistStatus[primaryTicker] && (() => {
            const wl = watchlistData[primaryTicker] ?? { addedDate: null, priceAdded: 0 }
            const stockId = portfolioData[primaryTicker]?.stockId ?? null
            const hasPriceAdded = wl.priceAdded > 0
            const changeDollar = hasPriceAdded ? currentPrice - wl.priceAdded : null
            const changePct = hasPriceAdded && wl.priceAdded > 0
              ? ((currentPrice - wl.priceAdded) / wl.priceAdded) * 100
              : null
            const changePositive = changeDollar != null && changeDollar >= 0
            const changeColor = changeDollar == null
              ? 'text-gray-400'
              : changePositive ? 'text-green-700' : 'text-red-600'

            const daysSince = wl.addedDate
              ? Math.max(0, Math.floor((Date.now() - new Date(wl.addedDate).getTime()) / 86_400_000))
              : null

            return (
              <div className="bg-white rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] border border-gray-100 mb-8 p-8 pb-7 section-your-watchlist">
                <h2 className="section-heading">Your Watchlist</h2>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Added to Watchlist</p>
                    <p className="text-xl font-bold text-gray-900 leading-tight mb-1">
                      {wl.addedDate ? formatDate(wl.addedDate) : '—'}
                    </p>
                    <p className="text-xs text-gray-500">
                      {daysSince != null
                        ? daysSince === 0 ? 'Today' : daysSince === 1 ? '1 day ago' : `${daysSince} days ago`
                        : ' '}
                    </p>
                  </div>

                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Price When Added</p>
                    {hasPriceAdded ? (
                      <>
                        <p className="text-xl font-bold text-gray-900 leading-tight mb-1">{formatCurrency(wl.priceAdded)}</p>
                        {changeDollar != null && (
                          <p className={`text-xs ${changeColor}`}>
                            {changePositive ? '+' : ''}{formatCurrency(changeDollar)} since added
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-xl font-bold text-gray-400 leading-tight mb-1">—</p>
                        <p className="text-xs text-gray-500">Not recorded</p>
                      </>
                    )}
                  </div>

                  <div className="bg-[#f7f8f6] rounded-lg px-4 pt-3.5 pb-4">
                    <p className="text-[10px] font-bold tracking-[0.09em] text-gray-500 uppercase mb-2">Change Since Added</p>
                    {changePct != null ? (
                      <>
                        <p className={`text-xl font-bold leading-tight mb-1 ${changeColor}`}>
                          {changePositive ? '+' : ''}{changePct.toFixed(2)}%
                        </p>
                        <p className={`text-xs ${changeColor}`}>
                          {changePositive ? 'Unrealized gain' : 'Unrealized loss'}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-xl font-bold text-gray-400 leading-tight">—</p>
                        <p className="text-xs text-gray-500">Needs entry price</p>
                      </>
                    )}
                  </div>
                </div>

                <div className="h-px bg-gray-200 mb-5" />

                <div className="flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-2.5">
                  <span className="text-xs text-gray-500 font-medium sm:mr-1">Manage watchlist</span>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setShowBuyFromWatchlist(true)}
                      disabled={stockId == null}
                      className="inline-flex items-center gap-1.5 px-3 sm:px-5 py-2 rounded-md text-[13px] font-semibold whitespace-nowrap bg-green-700 text-white border-[1.5px] border-green-700 hover:bg-green-800 hover:border-green-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                        <line x1="12" y1="5" x2="12" y2="19" strokeLinecap="round" />
                        <line x1="5" y1="12" x2="19" y2="12" strokeLinecap="round" />
                      </svg>
                      Buy shares
                    </button>
                    <button
                      type="button"
                      onClick={() => handleWatchlistToggle(primaryTicker)}
                      disabled={addingToWatchlist}
                      className="inline-flex items-center gap-1.5 px-3 sm:px-5 py-2 rounded-md text-[13px] font-semibold whitespace-nowrap bg-white text-red-700 border-[1.5px] border-red-300 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M10 11v6M14 11v6" strokeLinecap="round" />
                        <path d="M9 6V4h6v2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Remove
                    </button>
                  </div>
                  {wl.addedDate && (
                    <span className="text-[11px] text-gray-400 sm:ml-auto">
                      Watching since {formatDate(wl.addedDate)}
                    </span>
                  )}
                </div>
              </div>
            )
          })()}

          {showBuyFromWatchlist && portfolioData[primaryTicker]?.stockId != null && (
            <PurchaseFromWatchlistModal
              stock={{
                stock_id: portfolioData[primaryTicker]!.stockId as number,
                symbol: primaryTicker,
                company_name: stockDataMap[primaryTicker]?.stock?.name ?? primaryTicker,
              }}
              onClose={() => {
                setShowBuyFromWatchlist(false)
                fetchStockData(primaryTicker)
              }}
            />
          )}

          {manageAction && portfolioData[primaryTicker]?.stockId != null && (
            (() => {
              const pos = portfolioData[primaryTicker]
              const stockShape = {
                stock_id: pos.stockId as number,
                symbol: primaryTicker,
                company_name: stockData?.name ?? primaryTicker,
                shares: pos.shares,
                purchase_price: pos.purchasePrice,
              }
              const closeAndRefresh = () => {
                setManageAction(null)
                fetchStockData(primaryTicker)
              }
              return manageAction === 'buy'
                ? <BuyMoreModal stock={stockShape} onClose={closeAndRefresh} />
                : manageAction === 'sell'
                ? <SellModal stock={stockShape} onClose={closeAndRefresh} />
                : <RsuVestModal stock={stockShape} onClose={closeAndRefresh} />
            })()
          )}

        {/* ETF Top Holdings Panel */}
        {stockData.quoteType?.toUpperCase() === 'ETF' && (etfHoldingsLoading || (etfHoldings && etfHoldings.length > 0)) && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 section-top-holdings">
            <div className="flex items-baseline gap-2 mb-4">
              <h2 className="section-heading">Top Holdings</h2>
              <span className="text-sm text-gray-400 font-normal">{primaryTicker}</span>
            </div>
            {etfHoldingsLoading ? (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="animate-pulse flex items-center gap-4 py-2">
                    <div className="w-6 h-4 bg-gray-100 rounded" />
                    <div className="w-16 h-4 bg-gray-200 rounded" />
                    <div className="flex-1 h-4 bg-gray-100 rounded" />
                    <div className="w-12 h-4 bg-gray-100 rounded" />
                    <div className="w-16 h-5 bg-gray-100 rounded-full" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 uppercase text-xs border-b border-gray-100">
                      <th className="pb-2 pr-4 font-medium w-8">#</th>
                      <th className="pb-2 pr-4 font-medium">Ticker</th>
                      <th className="pb-2 pr-4 font-medium">Company</th>
                      <th className="pb-2 pr-4 font-medium text-right">Weight</th>
                      <th className="pb-2 font-medium text-right">GPS Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(etfHoldings ?? []).map((h, idx) => {
                      const gps = h.gps_score;
                      let pillClass = 'bg-gray-100 text-gray-500';
                      if (gps !== null) {
                        if (gps >= 65) pillClass = 'bg-green-100 text-green-800';
                        else if (gps >= 45) pillClass = 'bg-yellow-100 text-yellow-800';
                        else pillClass = 'bg-red-100 text-red-700';
                      }
                      return (
                        <tr key={h.ticker} className="border-b border-gray-50 hover:bg-[#f7f8f6] transition-colors">
                          <td className="py-2.5 pr-4 text-gray-400 font-medium">{idx + 1}</td>
                          <td className="py-2.5 pr-4">
                            <button
                              onClick={() => router.push(`/search/${h.ticker}`)}
                              className="font-semibold text-[#017e3b] hover:underline cursor-pointer"
                            >
                              {h.ticker}
                            </button>
                          </td>
                          <td className="py-2.5 pr-4 text-gray-600 max-w-[200px] truncate">{h.companyName}</td>
                          <td className="py-2.5 pr-4 text-right text-gray-700 font-medium tabular-nums">
                            {(h.holdingPercent * 100).toFixed(2)}%
                          </td>
                          <td className="py-2.5 text-right">
                            {gps !== null ? (
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums ${pillClass}`}>
                                {gps.toFixed(1)}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 section-prediction">
          <StockSignalPanel
            ticker={primaryTicker}
            gpsData={gpsData}
            gpsLoading={gpsLoading}
            onGeneratePrediction={() => predictionTriggerRef.current()}
            predictionLoading={predictionLoading}
            prefetchedPredictionAt={prefetchedPredictionAt}
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
            analystGradeScore={analystGrade?.composite ?? undefined}
            newsArticles={news}
            historicalEarnings={earningsData?.historicalEarnings || []}
            titleLevel="h2"
            triggerRef={predictionTriggerRef}
            onLoadingChange={onPredictionLoadingChange}
            onPredictionComplete={handlePredictionSuccess}
            onPredictionFailure={handlePredictionFailure}
            prefetchedPrediction={prefetchedPrediction}
            embedded
          />

          <div className="mt-4">
            <SymbolAccuracyIndicator ticker={primaryTicker} />
          </div>
        </div>

        {/* Analyst Sentiment & Price Targets */}
        {data.analyst && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 section-analyst-sentiment-targets">
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-heading" style={{ marginBottom: 0 }}>Analyst Sentiment & Targets</h2>
              {analystGrade && (
                <div className="flex flex-col items-end gap-3 sm:flex-row sm:items-center sm:gap-3">
                  <span className={`text-3xl font-bold px-4 py-1 rounded-xl border-2 ${gradeColor(analystGrade.grade)}`}>
                    {analystGrade.grade}
                  </span>
                  <span className="text-sm text-gray-500">{analystGrade.composite.toFixed(1)}/100</span>
                </div>
              )}
            </div>
            {analystGrade && (
              <div className="flex flex-wrap gap-3 mb-5 text-xs text-gray-600">
                <span>Rec <strong>{analystGrade.recScore.toFixed(1)}</strong></span>
                <span className="text-gray-300">|</span>
                <span>Upside <strong>{analystGrade.upsideScore.toFixed(1)}</strong></span>
                <span className="text-gray-300">|</span>
                <span>Momentum <strong>{analystGrade.momentumScore.toFixed(1)}</strong></span>
                <span className="text-gray-300">|</span>
                <span>Conviction <strong>{analystGrade.convictionScore.toFixed(1)}</strong></span>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-4">
              {/* Recommendation Trend */}
              <div>
                <h3 className="text-xl font-medium text-gray-700 mb-4">Recommendation Trend</h3>
                {data.analyst.recommendationTrend && data.analyst.recommendationTrend.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-[#f7f8f6]">
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
                  <div className="p-3 bg-[#f7f8f6] rounded-lg border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase">Low Target</p>
                    <p className="text-lg font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.low)}</p>
                  </div>
                  <div className="p-3 bg-[#f7f8f6] rounded-lg border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase">High Target</p>
                    <p className="text-lg font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.high)}</p>
                  </div>
                  <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
                    <p className="text-xs text-blue-600 uppercase font-semibold">Mean Target</p>
                    <p className="text-lg font-bold text-blue-800">{formatCurrency(data.analyst.priceTarget.mean)}</p>
                  </div>
                  <div className="p-3 bg-[#f7f8f6] rounded-lg border border-gray-100">
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
          <div className="mb-8 section-price-history-chart">
            <StockChart ticker={primaryTicker} historicalData={historical} titleLevel="h2" />
          </div>
        )}

        {/* Technical Indicators */}
        {indicators && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 section-technical-indicators-trading-signal">
            <h2 className="section-heading">Technical Indicators & Trading Signal</h2>
            <TechnicalIndicatorsDisplay indicators={indicators} titleLevel="h3" />
          </div>
        )}

        {/* Earnings Information */}
        {earningsData && (earningsData.upcomingEarnings || earningsData.historicalEarnings.length > 0) && (
          <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 section-earnings-information">
            <h2 className="section-heading">Earnings Information</h2>

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
                    <thead className="bg-[#f7f8f6]">
                      <tr>
                        <th scope="col" className="px-6 py-3 text-left text-[14px] font-medium text-gray-500 uppercase tracking-wider">Date</th>
                        <th scope="col" className="px-6 py-3 text-right text-[14px] font-medium text-gray-500 uppercase tracking-wider">EPS Actual</th>
                        <th scope="col" className="px-6 py-3 text-right text-[14px] font-medium text-gray-500 uppercase tracking-wider">EPS Estimate</th>
                        <th scope="col" className="px-6 py-3 text-right text-[14px] font-medium text-gray-500 uppercase tracking-wider">Revenue</th>
                        <th scope="col" className="px-6 py-3 text-right text-[14px] font-medium text-gray-500 uppercase tracking-wider">Earnings</th>
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
                          <tr key={index} className={`hover:bg-[#f7f8f6] font-medium ${rowColorClass}`}>
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
        <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8 section-latest-news">
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

          const analystGrade = computeAnalystGrade(
            data.analyst?.recommendationTrend,
            data.analyst?.priceTarget,
            currentPrice || null,
          )

          return (
            <div key={t} className="border-t-2 border-gray-200 pt-8">
              {/* Stock Info */}
              <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-6 section-stock-info">
                <div className="flex flex-col mb-6 md:flex-row md:items-center md:justify-between gap-7">
                  <h2 className="section-heading">
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
                        className="px-4 py-2 rounded-md text-white hover:opacity-90 disabled:opacity-50 border bg-[#017e3b] border-[#017e3b]"
                      >
                        {addingToWatchlist ? 'Updating...' : 'Remove from Watchlist'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleWatchlistToggle(t)}
                        disabled={addingToWatchlist}
                        className="px-4 py-2 rounded-md text-white hover:opacity-90 disabled:opacity-50 bg-[#017e3b]"
                      >
                        {addingToWatchlist ? 'Adding...' : 'Add to Watchlist'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
                    <p className="text-sm text-gray-500">Last Price</p>
                    <p className="text-2xl font-bold text-gray-800">{formatCurrency(currentPrice)}</p>
                  </div>

                  <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
                    <p className="text-sm text-gray-500">P/E Ratio</p>
                    <p className={`text-2xl font-bold ${typeof stockData.peRatio === 'number' && stockData.peRatio < 0 ? 'text-red-600' : 'text-gray-800'}`}>
                      {formatNumber(stockData.peRatio)}
                    </p>
                  </div>

                  <div className="p-4 bg-[#f7f8f6] rounded-lg border border-[#e9ede8]">
                    <p className="text-sm text-gray-500">Market Cap</p>
                    <p className="text-2xl font-bold text-gray-800">{stockData.marketCap ? formatNumber(stockData.marketCap / 1_000_000_000) + 'B' : 'N/A'}</p>
                  </div>
                </div>
              </div>

              {/* Chart */}
              {historical && historical.length > 0 && (
                <div className="mb-6 section-price-history-chart">
                  <StockChart ticker={t} historicalData={historical} titleLevel="h3" />
                </div>
              )}

              {/* Prediction */}
              {/* section:section-prediction */}
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
                analystGradeScore={analystGrade?.composite ?? undefined}
                newsArticles={news}
                titleLevel="h3"
              />

              {/* Analyst Sentiment & Price Targets */}
              {data.analyst && (
                <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-6 section-analyst-sentiment-targets">
                  <div className="flex items-center justify-between mb-4 gap-4">
                    <h3 className="text-xl font-semibold text-gray-800">📊 Analyst Sentiment & Targets</h3>
                    {analystGrade && (
                      <div className="flex items-center gap-2">
                        <span className={`text-2xl font-bold px-3 py-1 rounded-xl border-2 ${gradeColor(analystGrade.grade)}`}>
                          {analystGrade.grade}
                        </span>
                        <span className="text-xs text-gray-500">{analystGrade.composite.toFixed(1)}</span>
                      </div>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-4">
                    {/* Recommendation Trend */}
                    <div>
                      <h4 className="text-lg font-medium text-gray-700 mb-4">Recommendation Trend</h4>
                      {data.analyst.recommendationTrend && data.analyst.recommendationTrend.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-[#f7f8f6]">
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
                        <div className="p-2 bg-[#f7f8f6] rounded-lg border border-gray-100">
                          <p className="text-[10px] text-gray-500 uppercase">Low</p>
                          <p className="text-md font-bold text-gray-800">{formatCurrency(data.analyst.priceTarget.low)}</p>
                        </div>
                        <div className="p-2 bg-[#f7f8f6] rounded-lg border border-gray-100">
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
                <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-6 section-technical-indicators">
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
