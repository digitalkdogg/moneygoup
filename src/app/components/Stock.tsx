'use client'

import { useState, useEffect } from 'react'
import { calculateTechnicalIndicators, TechnicalIndicators } from '@/utils/technicalIndicators'
import ApiErrorDisplay, { ApiError } from './ApiErrorDisplay'
import TechnicalIndicatorsDisplay from './TechnicalIndicatorsDisplay'

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
  const [historicalData, setHistoricalData] = useState<HistoricalResponse | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [indicators, setIndicators] = useState<TechnicalIndicators | null>(null)
  const [historicalLoading, setHistoricalLoading] = useState(false)
  const [fullYearData, setFullYearData] = useState<HistoricalData[] | null>(null)
  const [currentPeriod, setCurrentPeriod] = useState('1M')
  const [apiError, setApiError] = useState<ApiError | null>(null)

  // Fetch current stock data
  const fetchStockData = async (ticker: string) => {
    setLoading(true)
    setStockData(null)
    setFullYearData(null)
    setHistoricalData(null)
    setMetrics(null)
    setIndicators(null)
    setApiError(null)
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

  // Calculate metrics from historical data
  const updateMetrics = (data: HistoricalData[]) => {
    if (Array.isArray(data) && data.length > 0) {
      const startPrice = data[0].close
      const endPrice = data[data.length - 1].close
      const dollarChange = endPrice - startPrice
      const percentChange = ((endPrice - startPrice) / startPrice) * 100
      const dailyChanges = data.map(d => d.close - d.open)
      const avgDailyChange = dailyChanges.reduce((a, b) => a + b, 0) / dailyChanges.length
      setMetrics({ dollarChange, percentChange, avgDailyChange })
    }
  }

  // Filter data by period
  const filterDataByPeriod = (data: HistoricalData[], period: string): HistoricalData[] => {
    if (!Array.isArray(data) || data.length === 0) return data
    let daysBack = 30
    if (period === '6M') daysBack = 180
    if (period === '1Y') daysBack = 365
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysBack)
    return data.filter(d => {
      const dataDate = new Date(d.date || d.datetime || '')
      return dataDate >= cutoffDate
    })
  }

  // Fetch historical data
  const fetchHistoricalData = async (ticker: string, period: string) => {
    setHistoricalLoading(true)
    setCurrentPeriod(period)
    setHistoricalData(null)
    setMetrics(null)
    setIndicators(null)
    setApiError(null)

    try {
      if (!fullYearData) {
        const url = source === 'dashboard' ? `/api/stock/${ticker}/historical/1Y?source=dashboard` : `/api/stock/${ticker}/historical/1Y`
        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data) && data.length > 0) {
            setFullYearData(data)
            const filteredData = filterDataByPeriod(data, period)
            setHistoricalData(filteredData)
            updateMetrics(filteredData)
            // Calculate indicators from FULL year data (not filtered)
            const calcs = calculateTechnicalIndicators(data)
            setIndicators(calcs)
          }
        } else {
          const errorData = await res.json()
          setApiError({
            type: 'historical',
            ticker: ticker,
            message: errorData.error || 'Failed to fetch historical data',
            details: errorData.details,
            failedServices: errorData.failedServices
          })
          setHistoricalData({ error: errorData.error })
        }
      } else {
        const filteredData = filterDataByPeriod(fullYearData, period)
        setHistoricalData(filteredData)
        updateMetrics(filteredData)
        // Calculate indicators from FULL year data (not filtered)
        const calcs = calculateTechnicalIndicators(fullYearData)
        setIndicators(calcs)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Network connection failed'
      setApiError({
        type: 'historical',
        ticker: ticker,
        message: 'Network error while fetching historical data',
        details: errorMessage,
        failedServices: ['Tiingo', '12Data']
      })
      setHistoricalData({ error: 'Network error. Please check your connection.' })
    }
    setHistoricalLoading(false)
  }

  useEffect(() => {
    if (ticker) {
      fetchStockData(ticker)
    }
  }, [ticker])

  // Auto-fetch historical data when a stock is selected
  useEffect(() => {
    if (ticker && stockData && !stockData.error) {
      fetchHistoricalData(ticker, '1M')
    }
  }, [ticker, stockData])


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
                <div className="text-3xl font-bold text-gray-900">${(stockData.last || stockData.close || stockData.tngoLast) ? (stockData.last || stockData.close || stockData.tngoLast).toFixed(2) : 'N/A'}</div>
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
          <div className="bg-white p-8 rounded-2xl shadow-2xl">
            <h3 className="text-3xl font-bold text-gray-800 mb-6 text-center">📊 Historical Data & Technical Analysis</h3>
            
            {/* Period Buttons */}
            <div className="flex justify-center space-x-4 mb-8 flex-wrap gap-4">
              <button 
                onClick={() => fetchHistoricalData(ticker, '1M')}
                className={`px-6 py-3 rounded-lg font-semibold transition duration-200 shadow-lg ${
                  currentPeriod === '1M' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                1 Month
              </button>
              <button 
                onClick={() => fetchHistoricalData(ticker, '6M')}
                className={`px-6 py-3 rounded-lg font-semibold transition duration-200 shadow-lg ${
                  currentPeriod === '6M' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                6 Months
              </button>
              <button 
                onClick={() => fetchHistoricalData(ticker, '1Y')}
                className={`px-6 py-3 rounded-lg font-semibold transition duration-200 shadow-lg ${
                  currentPeriod === '1Y' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                1 Year
              </button>
            </div>

            {/* Loading */}
            {historicalLoading && (
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                <p className="mt-2 text-gray-600">Loading technical analysis...</p>
              </div>
            )}

            {/* Historical Data & Indicators Display */}
            {historicalData && !historicalLoading && (
              <div>
                {'error' in historicalData ? (
                  <p className="text-center text-red-500 font-semibold">{historicalData.error}</p>
                ) : Array.isArray(historicalData) && historicalData.length > 0 && metrics ? (
                  <>
                    {/* Metrics */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                      <div className="bg-white p-6 rounded-xl text-gray-900 shadow-md text-center border-1 border-slate-300">
                        <div className="text-sm font-medium opacity-80">Dollar Change</div>
                        <div className={`text-3xl font-bold ${
                          metrics.dollarChange >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          ${Math.abs(metrics.dollarChange).toFixed(2)} {metrics.dollarChange >= 0 ? '↑' : '↓'}
                        </div>
                      </div>
                      <div className="bg-white p-6 rounded-xl text-gray-900 shadow-md text-center border-1 border-slate-300">
                        <div className="text-sm font-medium opacity-80">Percent Change</div>
                        <div className={`text-3xl font-bold ${
                          metrics.percentChange >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {metrics.percentChange >= 0 ? '+' : ''}{metrics.percentChange.toFixed(2)}%
                        </div>
                      </div>
                      <div className="bg-white p-6 rounded-xl text-gray-900 shadow-md text-center border-1 border-slate-300">
                        <div className="text-sm font-medium opacity-80">Avg Daily Change</div>
                        <div className={`text-3xl font-bold ${
                          metrics.avgDailyChange >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          ${Math.abs(metrics.avgDailyChange).toFixed(2)} {metrics.avgDailyChange >= 0 ? '↑' : '↓'}
                        </div>
                      </div>
                    </div>

                    {/* Technical Indicators */}
                    {indicators && (
                      <TechnicalIndicatorsDisplay
                        indicators={indicators}
                        metrics={metrics}
                        historicalData={historicalData as HistoricalData[]}
                      />
                    )}
                  </>
                ) : (
                  <p className="text-center text-gray-500">No historical data available for this period.</p>
                )}
              </div>
            )}
          </div>
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
            onRetryHistorical={() => {
              setApiError(null)
              fetchHistoricalData(ticker, currentPeriod)
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
