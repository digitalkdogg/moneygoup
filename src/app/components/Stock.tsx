'use client'

import { useState, useEffect } from 'react'
import { calculateTechnicalIndicators, TechnicalIndicators } from '@/utils/technicalIndicators'
import { calculateAnnualizedVolatility, getVolatilityRating } from '@/utils/volatility'
import ApiErrorDisplay, { ApiError } from './ApiErrorDisplay'
import TechnicalIndicatorsDisplay from './TechnicalIndicatorsDisplay'
import StockChart from './StockChart'
import StockNews from './StockNews'

interface StockData {
  symbol?: string
  name?: string
  last?: number
  tngoLast?: number
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  prevClose?: number
  timestamp?: string
  exchange?: string
  error?: string
}

interface HistoricalData {
  date?: string
  datetime?: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface Metrics {
  dollarChange: number
  percentChange: number
  avgDailyChange: number
}

type HistoricalResponse = HistoricalData[] | { error: string }

export default function Stock({ ticker, source }: { ticker: string; source?: string }) {
  const [stockData, setStockData] = useState<StockData | null>(null)
  const [loading, setLoading] = useState(false)
  const [indicators, setIndicators] = useState<TechnicalIndicators | null>(null)
  const [apiError, setApiError] = useState<ApiError | null>(null)
  const [volatilityRating, setVolatilityRating] = useState<"Low" | "Medium" | "High" | "N/A" | null>(null);
  const [news, setNews] = useState<any[]>([]);


  // Fetch current stock data
  const fetchStockData = async (ticker: string) => {
    setLoading(true)
    setStockData(null)
    setIndicators(null)
    setApiError(null)
    setVolatilityRating(null)
    setNews([]);
    try {
      const url = source === 'dashboard' ? `/api/stock/${ticker}?source=dashboard` : `/api/stock/${ticker}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setStockData(data)
      } else {
        const errorData = await res.json()
        setApiError({
          type: 'stock',
          ticker: ticker,
          message: errorData.error || 'Failed to fetch stock data',
          details: errorData.details,
          failedServices: errorData.failedServices
        })
        setStockData({ error: errorData.error })
      }

      const news_res = await fetch(`/api/stock/${ticker}/news`);
      let news_data: any[] = [];
      if (news_res.ok) {
        news_data = await news_res.json();
        setNews(news_data);
      }

      const hist_url = source === 'dashboard' ? `/api/stock/${ticker}/historical/1Y?source=dashboard` : `/api/stock/${ticker}/historical/1Y`
      const hist_res = await fetch(hist_url)
      if (hist_res.ok) {
        const data = await hist_res.json()
        if (Array.isArray(data) && data.length > 0) {
          const calcs = calculateTechnicalIndicators(data, news_data)
          setIndicators(calcs)
          
          // Calculate volatility from FULL year data
          const annualizedVolatility = calculateAnnualizedVolatility(data);
          const rating = getVolatilityRating(annualizedVolatility);
          setVolatilityRating(rating);

        }
      } else {
        const errorData = await hist_res.json()
        setApiError({
          type: 'historical',
          ticker: ticker,
          message: errorData.error || 'Failed to fetch historical data',
          details: errorData.details,
          failedServices: errorData.failedServices
        })
      }


    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Network connection failed'
      setApiError({
        type: 'stock',
        ticker: ticker,
        message: 'Network error while fetching stock data',
        details: errorMessage,
        failedServices: ['Tiingo', '12Data']
      })
      setStockData({ error: 'Network error. Please check your connection.' })
    }
    setLoading(false)
  }



  useEffect(() => {
    if (ticker) {
      fetchStockData(ticker)
    }
  }, [ticker])

  const getVolatilityClass = (volatility: string | null) => {
    if (!volatility) return "bg-gray-100 text-gray-800";
    switch (volatility) {
      case "Low":
        return "bg-green-100 text-green-800";
      case "Medium":
        return "bg-yellow-100 text-yellow-800";
      case "High":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const currentPrice = stockData ? (stockData.last || stockData.close || stockData.tngoLast) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        {/* Loading State */}
        {loading && (
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            <p className="mt-4 text-lg text-gray-600">Loading stock data...</p>
          </div>
        )}

        {/* Stock Data Card */}
        {stockData && !stockData.error && (
          <div className="bg-white p-8 rounded-2xl shadow-2xl mb-8">
            <h2 className="text-3xl font-bold text-gray-800 mb-6 text-center">
              {stockData.symbol || stockData.name || ticker}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-xl shadow-md border-1 border-slate-300">
                <div className="text-sm font-medium text-gray-700 opacity-80">Last Price</div>
                <div className="text-3xl font-bold text-gray-900">${typeof currentPrice === 'number' ? currentPrice.toFixed(2) : 'N/A'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-md border-1 border-slate-300">
                <div className="text-sm font-medium text-gray-700 opacity-80">Open</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.open ? stockData.open.toFixed(2) : 'N/A'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-md border-1 border-slate-300">
                <div className="text-sm font-medium text-gray-700 opacity-80">High</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.high ? stockData.high.toFixed(2) : 'N/A'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-md border-1 border-slate-300">
                <div className="text-sm font-medium text-gray-700 opacity-80">Low</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.low ? stockData.low.toFixed(2) : 'N/A'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-md border-1 border-slate-300">
                <div className="text-sm font-medium text-gray-700 opacity-80">Volume</div>
                <div className="text-2xl font-bold text-gray-900">{(stockData.volume || 0).toLocaleString()}</div>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-md border-1 border-slate-300">
                <div className="text-sm font-medium text-gray-700 opacity-80">Previous Close</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.prevClose ? stockData.prevClose.toFixed(2) : 'N/A'}</div>
              </div>
            </div>
          </div>
        )}

        {/* Historical Data & Technical Indicators */}
        {stockData && !stockData.error && (
          <>
            <div className="bg-white p-4 md:p-6 rounded-2xl shadow-2xl mb-8">
              <StockChart ticker={ticker} />
            </div>
            <div className="mb-8">
              <StockNews articles={news} />
            </div>
            <div className="bg-white p-8 rounded-2xl shadow-2xl">
              <h3 className="text-3xl font-bold text-gray-800 mb-6 text-center">📊 Technical Analysis</h3>
              
              {/* Volatility Rating Display */}
              {volatilityRating && volatilityRating !== "N/A" && (
                  <div className="bg-white p-6 rounded-2xl shadow-2xl mb-8 flex items-center justify-center">
                      <p className="text-xl font-semibold text-gray-700 mr-4">Annualized Volatility:</p>
                      <span className={`px-4 py-2 inline-flex text-xl leading-5 font-semibold rounded-full ${getVolatilityClass(volatilityRating)}`}>
                          {volatilityRating}
                      </span>
                  </div>
              )}

              {/* Technical Indicators */}
              {indicators ? (
                <TechnicalIndicatorsDisplay
                  indicators={indicators}
                />
              ) : (
                <div className="text-center">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                  <p className="mt-2 text-gray-600">Loading technical analysis...</p>
                </div>
              )}
            </div>
          </>
        )}

        {/* API Error Display */}
        {apiError && (
          <ApiErrorDisplay
            error={apiError}
            selectedTicker={ticker}
            onRetryStock={() => {
              setApiError(null)
              if (ticker) {
                fetchStockData(ticker)
              }
            }}
          />
        )}

        {/* Error State (fallback) */}
        {stockData && stockData.error && !apiError && (
          <div className="bg-red-100 border-2 border-red-400 text-red-700 px-6 py-4 rounded-xl text-center shadow-lg font-semibold">
            Error: Failed to fetch data for {ticker}. Please try again.
          </div>
        )}
      </div>
    </div>
  )
}