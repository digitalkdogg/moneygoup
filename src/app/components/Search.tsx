'use client'

import { useState, useEffect } from 'react'
import { calculateTechnicalIndicators, TechnicalIndicators } from '@/utils/technicalIndicators'

interface Ticker {
  name: string
  ticker: string
}

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

export default function Search() {
  const [tickers, setTickers] = useState<Ticker[]>([])
  const [searchValue, setSearchValue] = useState('')
  const [filteredTickers, setFilteredTickers] = useState<Ticker[]>([])
  const [selectedTicker, setSelectedTicker] = useState('')
  const [stockData, setStockData] = useState<StockData | null>(null)
  const [loading, setLoading] = useState(false)
  const [historicalData, setHistoricalData] = useState<HistoricalResponse | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [indicators, setIndicators] = useState<TechnicalIndicators | null>(null)
  const [historicalLoading, setHistoricalLoading] = useState(false)
  const [fullYearData, setFullYearData] = useState<HistoricalData[] | null>(null)
  const [currentPeriod, setCurrentPeriod] = useState('1M')

  // Load ticker list on mount
  useEffect(() => {
    fetch('/company_tickers.json')
      .then(res => res.json())
      .then(data => {
        const list: Ticker[] = data.map((item: any) => ({
          name: item.name,
          ticker: item.ticker
        }))
        setTickers(list)
      })
      .catch(err => console.error('Failed to fetch tickers', err))
  }, [])

  // Auto-fetch historical data when a stock is selected
  useEffect(() => {
    if (selectedTicker && stockData && !stockData.error) {
      fetchHistoricalData(selectedTicker, '1M')
    }
  }, [selectedTicker, stockData])

  // Filter tickers as user types
  useEffect(() => {
    if (searchValue) {
      const filtered = tickers.filter(t =>
        t.ticker.toLowerCase().includes(searchValue.toLowerCase()) ||
        t.name.toLowerCase().includes(searchValue.toLowerCase())
      ).slice(0, 10)
      setFilteredTickers(filtered)
    } else {
      setFilteredTickers([])
    }
  }, [searchValue, tickers])

  // Fetch current stock data
  const fetchStockData = async (ticker: string) => {
    setLoading(true)
    setStockData(null)
    setFullYearData(null)
    setHistoricalData(null)
    setMetrics(null)
    setIndicators(null)
    try {
      const res = await fetch(`/api/stock/${ticker}`)
      if (res.ok) {
        const data = await res.json()
        setStockData(data)
      } else {
        console.error('API failed')
      }
    } catch (err) {
      console.error('Fetch failed', err)
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

    try {
      if (!fullYearData) {
        const res = await fetch(`/api/stock/${ticker}/historical/1Y`)
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
          setHistoricalData({ error: 'Failed to fetch historical data' })
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
      console.error('Historical fetch failed', err)
      setHistoricalData({ error: 'Failed to fetch historical data' })
    }
    setHistoricalLoading(false)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchValue(e.target.value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const ticker = searchValue.toUpperCase()
      setSelectedTicker(ticker)
      setSearchValue('')
      setFilteredTickers([])
      fetchStockData(ticker)
    }
  }

  const handleSelectTicker = (ticker: Ticker) => {
    setSelectedTicker(ticker.ticker)
    setSearchValue('')
    setFilteredTickers([])
    fetchStockData(ticker.ticker)
    fetchHistoricalData(ticker.ticker, '1M')
  }

  const getSignalColor = (signal: string): string => {
    switch (signal) {
      case 'BUY':
        return 'bg-green-100 border-green-400 text-green-800'
      case 'SELL':
        return 'bg-red-100 border-red-400 text-red-800'
      default:
        return 'bg-yellow-100 border-yellow-400 text-yellow-800'
    }
  }

  const getRSIColor = (rsi: number | null): string => {
    if (rsi === null) return 'text-gray-600'
    if (rsi > 70) return 'text-red-600 font-bold'
    if (rsi < 30) return 'text-green-600 font-bold'
    return 'text-gray-600'
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <header className="text-center mb-12">
          <h2 className="text-4xl font-bold text-gray-800 mb-4">Stock Search</h2>
          <p className="text-lg text-gray-600">Track your favorite stocks in real-time</p>
        </header>

        {/* Search Input */}
        <div className="mb-12 relative">
          <input
            type="text"
            value={searchValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Search for a stock ticker or company name..."
            className="w-full p-4 text-lg border-2 border-gray-300 rounded-xl shadow-lg focus:outline-none focus:ring-4 focus:ring-blue-300 focus:border-blue-500 transition duration-200"
          />
          {filteredTickers.length > 0 && (
            <ul className="absolute z-10 w-full bg-white border-2 border-gray-300 rounded-xl shadow-xl mt-2 max-h-64 overflow-y-auto">
              {filteredTickers.map(t => (
                <li
                  key={t.ticker}
                  onClick={() => handleSelectTicker(t)}
                  className="p-4 hover:bg-blue-50 cursor-pointer border-b border-gray-200 last:border-b-0 transition duration-150"
                >
                  <div className="font-semibold text-gray-800">{t.ticker}</div>
                  <div className="text-sm text-gray-600">{t.name}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

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
              {stockData.symbol || stockData.name || selectedTicker}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-6 rounded-xl shadow-md border-l-4 border-blue-600">
                <div className="text-sm font-medium text-gray-700 opacity-80">Last Price</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.last || stockData.close || stockData.tngoLast || 'N/A'}</div>
              </div>
              <div className="bg-gradient-to-br from-purple-50 to-purple-100 p-6 rounded-xl shadow-md border-l-4 border-purple-600">
                <div className="text-sm font-medium text-gray-700 opacity-80">Open</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.open || 'N/A'}</div>
              </div>
              <div className="bg-gradient-to-br from-green-50 to-green-100 p-6 rounded-xl shadow-md border-l-4 border-green-600">
                <div className="text-sm font-medium text-gray-700 opacity-80">High</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.high || 'N/A'}</div>
              </div>
              <div className="bg-gradient-to-br from-red-50 to-red-100 p-6 rounded-xl shadow-md border-l-4 border-red-600">
                <div className="text-sm font-medium text-gray-700 opacity-80">Low</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.low || 'N/A'}</div>
              </div>
              <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 p-6 rounded-xl shadow-md border-l-4 border-indigo-600">
                <div className="text-sm font-medium text-gray-700 opacity-80">Volume</div>
                <div className="text-2xl font-bold text-gray-900">{(stockData.volume || 0).toLocaleString()}</div>
              </div>
              <div className="bg-gradient-to-br from-orange-50 to-orange-100 p-6 rounded-xl shadow-md border-l-4 border-orange-600">
                <div className="text-sm font-medium text-gray-700 opacity-80">Previous Close</div>
                <div className="text-3xl font-bold text-gray-900">${stockData.prevClose || 'N/A'}</div>
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
                onClick={() => fetchHistoricalData(selectedTicker, '1M')}
                className={`px-6 py-3 rounded-lg font-semibold transition duration-200 shadow-lg ${
                  currentPeriod === '1M' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                1 Month
              </button>
              <button 
                onClick={() => fetchHistoricalData(selectedTicker, '6M')}
                className={`px-6 py-3 rounded-lg font-semibold transition duration-200 shadow-lg ${
                  currentPeriod === '6M' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                6 Months
              </button>
              <button 
                onClick={() => fetchHistoricalData(selectedTicker, '1Y')}
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
                      <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-6 rounded-xl text-gray-900 shadow-md text-center border-l-4 border-blue-600">
                        <div className="text-sm font-medium opacity-80">Dollar Change</div>
                        <div className={`text-3xl font-bold ${
                          metrics.dollarChange >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {metrics.dollarChange >= 0 ? '+' : ''}{metrics.dollarChange.toFixed(2)}
                        </div>
                      </div>
                      <div className="bg-gradient-to-br from-purple-50 to-purple-100 p-6 rounded-xl text-gray-900 shadow-md text-center border-l-4 border-purple-600">
                        <div className="text-sm font-medium opacity-80">Percent Change</div>
                        <div className={`text-3xl font-bold ${
                          metrics.percentChange >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {metrics.percentChange >= 0 ? '+' : ''}{metrics.percentChange.toFixed(2)}%
                        </div>
                      </div>
                      <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 p-6 rounded-xl text-gray-900 shadow-md text-center border-l-4 border-indigo-600">
                        <div className="text-sm font-medium opacity-80">Avg Daily Change</div>
                        <div className={`text-3xl font-bold ${
                          metrics.avgDailyChange >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {metrics.avgDailyChange >= 0 ? '+' : ''}{metrics.avgDailyChange.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {/* Technical Indicators */}
                    {indicators && (
                      <div className="bg-gradient-to-br from-slate-50 to-slate-100 p-8 rounded-2xl shadow-lg border-2 border-indigo-300">
                        <h4 className="text-2xl font-bold text-gray-800 mb-6 text-center">🎯 Technical Indicators & Trading Signal</h4>
                        
                        {/* Main Signal Box */}
                        <div className={`p-8 rounded-xl border-2 mb-8 text-center ${getSignalColor(indicators.signal)}`}>
                          <div className="text-sm font-semibold opacity-80 mb-2">TRADING SIGNAL</div>
                          <div className="text-5xl font-bold mb-3">{indicators.signal}</div>
                          <div className="text-base font-semibold mb-2">Signal Strength: {indicators.signalStrength}%</div>
                          <div className="text-sm leading-relaxed mt-4">{indicators.signalReason}</div>
                        </div>

                        {/* Score Breakdown Table */}
                        <div className="bg-white rounded-xl p-6 mb-8 shadow-md border border-gray-300 overflow-x-auto">
                          <h5 className="text-lg font-bold text-gray-800 mb-4">📈 Signal Score Breakdown</h5>
                          <div className="w-full">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="bg-gray-100 border-b-2 border-gray-300">
                                  <th className="text-left py-3 px-4 font-bold text-gray-800">Metric</th>
                                  <th className="text-center py-3 px-4 font-bold text-gray-800">Score</th>
                                  <th className="text-left py-3 px-4 font-bold text-gray-800">Details</th>
                                </tr>
                              </thead>
                              <tbody>
                                {/* MA Crossover */}
                                <tr className="border-b border-gray-200 hover:bg-gray-50">
                                  <td className="py-3 px-4 font-semibold text-gray-800">MA Crossover (20/50)</td>
                                  <td className={`text-center py-3 px-4 font-bold text-lg ${
                                    indicators.scoreBreakdown.maScore > 0 ? 'text-green-600' : 
                                    indicators.scoreBreakdown.maScore < 0 ? 'text-red-600' : 
                                    'text-gray-600'
                                  }`}>
                                    {indicators.scoreBreakdown.maScore > 0 ? '+' : ''}{indicators.scoreBreakdown.maScore}
                                  </td>
                                  <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.maReason}</td>
                                </tr>

                                {/* RSI */}
                                <tr className="border-b border-gray-200 hover:bg-gray-50">
                                  <td className="py-3 px-4 font-semibold text-gray-800">RSI (14)</td>
                                  <td className={`text-center py-3 px-4 font-bold text-lg ${
                                    indicators.scoreBreakdown.rsiScore > 0 ? 'text-green-600' : 
                                    indicators.scoreBreakdown.rsiScore < 0 ? 'text-red-600' : 
                                    'text-gray-600'
                                  }`}>
                                    {indicators.scoreBreakdown.rsiScore > 0 ? '+' : ''}{indicators.scoreBreakdown.rsiScore}
                                  </td>
                                  <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.rsiReason}</td>
                                </tr>

                                {/* Momentum */}
                                <tr className="border-b border-gray-200 hover:bg-gray-50">
                                  <td className="py-3 px-4 font-semibold text-gray-800">Momentum (10d)</td>
                                  <td className={`text-center py-3 px-4 font-bold text-lg ${
                                    indicators.scoreBreakdown.momentumScore > 0 ? 'text-green-600' : 
                                    indicators.scoreBreakdown.momentumScore < 0 ? 'text-red-600' : 
                                    'text-gray-600'
                                  }`}>
                                    {indicators.scoreBreakdown.momentumScore > 0 ? '+' : ''}{indicators.scoreBreakdown.momentumScore}
                                  </td>
                                  <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.momentumReason}</td>
                                </tr>

                                {/* Price vs MA50 */}
                                <tr className="border-b-2 border-gray-300 hover:bg-gray-50">
                                  <td className="py-3 px-4 font-semibold text-gray-800">Price vs SMA(50)</td>
                                  <td className={`text-center py-3 px-4 font-bold text-lg ${
                                    indicators.scoreBreakdown.priceScore > 0 ? 'text-green-600' : 
                                    indicators.scoreBreakdown.priceScore < 0 ? 'text-red-600' : 
                                    'text-gray-600'
                                  }`}>
                                    {indicators.scoreBreakdown.priceScore > 0 ? '+' : ''}{indicators.scoreBreakdown.priceScore}
                                  </td>
                                  <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.priceReason}</td>
                                </tr>

                                {/* Total Score */}
                                <tr className="bg-blue-50 font-bold">
                                  <td className="py-4 px-4 text-gray-900">TOTAL SCORE</td>
                                  <td className={`text-center py-4 px-4 text-2xl ${
                                    indicators.scoreBreakdown.totalScore >= 4 ? 'text-green-600' : 
                                    indicators.scoreBreakdown.totalScore <= -4 ? 'text-red-600' : 
                                    'text-blue-600'
                                  }`}>
                                    {indicators.scoreBreakdown.totalScore > 0 ? '+' : ''}{indicators.scoreBreakdown.totalScore}
                                  </td>
                                  <td className="py-4 px-4 text-gray-700">
                                    {indicators.scoreBreakdown.totalScore >= 4 ? '✅ BUY Signal' :
                                     indicators.scoreBreakdown.totalScore <= -4 ? '⚠️ SELL Signal' :
                                     '➡️ HOLD Signal'}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          <div className="mt-4 p-3 bg-blue-50 rounded-lg border-l-4 border-blue-500 text-sm text-gray-700">
                            <p><span className="font-semibold">Score Thresholds:</span> {'≥'}4 = BUY | {'≤'}-4 = SELL | -3 to 3 = HOLD</p>
                          </div>
                        </div>

                        {/* Indicators Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                          {/* SMA 20 */}
                          <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-blue-500 hover:shadow-lg transition">
                            <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">SMA 20</div>
                            <div className="text-2xl font-bold text-gray-800">
                              {indicators.sma20 !== null ? indicators.sma20.toFixed(2) : 'N/A'}
                            </div>
                            <div className="text-xs text-gray-600 mt-2">20-day Avg</div>
                          </div>

                          {/* SMA 50 */}
                          <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-purple-500 hover:shadow-lg transition">
                            <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">SMA 50</div>
                            <div className="text-2xl font-bold text-gray-800">
                              {indicators.sma50 !== null ? indicators.sma50.toFixed(2) : 'N/A'}
                            </div>
                            <div className="text-xs text-gray-600 mt-2">50-day Avg</div>
                          </div>

                          {/* RSI */}
                          <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-orange-500 hover:shadow-lg transition">
                            <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">RSI (14)</div>
                            <div className={`text-2xl font-bold ${getRSIColor(indicators.rsi14)}`}>
                              {indicators.rsi14 !== null ? indicators.rsi14.toFixed(2) : 'N/A'}
                            </div>
                            <div className="text-xs text-gray-600 mt-2">
                              {indicators.rsi14 !== null
                                ? indicators.rsi14 > 70
                                  ? '⚠️ Overbought'
                                  : indicators.rsi14 < 30
                                  ? '✅ Oversold'
                                  : '➡️ Neutral'
                                : 'N/A'}
                            </div>
                          </div>

                          {/* Momentum */}
                          <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-green-500 hover:shadow-lg transition">
                            <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Momentum</div>
                            <div className={`text-2xl font-bold ${
                              indicators.momentum !== null && indicators.momentum > 0
                                ? 'text-green-600'
                                : indicators.momentum !== null && indicators.momentum < 0
                                ? 'text-red-600'
                                : 'text-gray-800'
                            }`}>
                              {indicators.momentum !== null ? indicators.momentum.toFixed(2) : 'N/A'}
                            </div>
                            <div className="text-xs text-gray-600 mt-2">
                              {indicators.momentum !== null
                                ? indicators.momentum > 0
                                  ? '📈 Bullish'
                                  : '📉 Bearish'
                                : 'N/A'}
                            </div>
                          </div>
                        </div>

                        {/* Educational Info */}
                        <div className="bg-white rounded-lg p-6 border border-gray-300">
                          <h5 className="text-lg font-bold text-gray-800 mb-4">📚 Indicator Guide</h5>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-700">
                            <div>
                              <p className="font-semibold text-gray-800">SMA (Simple Moving Average)</p>
                              <p className="mt-1">20 {'>'} 50 = Bullish trend. 20 {'<'} 50 = Bearish trend. Price above 50-SMA = Uptrend support.</p>
                            </div>
                            <div>
                              <p className="font-semibold text-gray-800">RSI (Relative Strength Index)</p>
                              <p className="mt-1">{'<'}30 = Oversold (buying opportunity). {'>'}70 = Overbought (selling pressure). 40-60 = Neutral.</p>
                            </div>
                            <div>
                              <p className="font-semibold text-gray-800">Momentum</p>
                              <p className="mt-1">Positive = Price rising faster (bullish). Negative = Price falling (bearish). Measures rate of change.</p>
                            </div>
                            <div>
                              <p className="font-semibold text-gray-800">Trading Signal</p>
                              <p className="mt-1">Composite signal combining all indicators. Base real decisions on multiple factors and do your own research!</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-center text-gray-500">No historical data available for this period.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Error State */}
        {stockData && stockData.error && (
          <div className="bg-red-100 border-2 border-red-400 text-red-700 px-6 py-4 rounded-xl text-center shadow-lg font-semibold">
            Error: Failed to fetch data for {selectedTicker}. Please try again.
          </div>
        )}
      </div>
    </div>
  )
}