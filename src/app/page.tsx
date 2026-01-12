'use client'

import { useState, useEffect } from 'react'

interface Ticker {
  cik: string
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

export default function Home() {
  const [tickers, setTickers] = useState<Ticker[]>([])
  const [searchValue, setSearchValue] = useState('')
  const [filteredTickers, setFilteredTickers] = useState<Ticker[]>([])
  const [selectedTicker, setSelectedTicker] = useState('')
  const [stockData, setStockData] = useState<StockData | null>(null)
  const [loading, setLoading] = useState(false)
  const [historicalData, setHistoricalData] = useState<HistoricalResponse | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [historicalLoading, setHistoricalLoading] = useState(false)

  useEffect(() => {
    fetch('/company_tickers.json')
      .then(res => res.json())
      .then(data => {
        const list: Ticker[] = Object.values(data).map((item: any) => ({
          cik: item.cik_str,
          name: item.title,
          ticker: item.ticker
        }))
        setTickers(list)
      })
      .catch(err => console.error('Failed to fetch tickers', err))
  }, [])

  useEffect(() => {
    if (searchValue) {
      const filtered = tickers.filter(t =>
        t.ticker.toLowerCase().includes(searchValue.toLowerCase()) ||
        t.name.toLowerCase().includes(searchValue.toLowerCase())
      ).slice(0, 10) // limit to 10
      setFilteredTickers(filtered)
    } else {
      setFilteredTickers([])
    }
  }, [searchValue, tickers])

  const fetchStockData = async (ticker: string) => {
    setLoading(true)
    setStockData(null)
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

  const fetchHistoricalData = async (ticker: string, period: string) => {
    setHistoricalLoading(true)
    setHistoricalData(null)
    setMetrics(null)
    try {
      const res = await fetch(`/api/stock/${ticker}/historical/${period}`)
      if (res.ok) {
        const data = await res.json()
        setHistoricalData(data)
        if (Array.isArray(data) && data.length > 0) {
          const startPrice = data[0].close
          const endPrice = data[data.length - 1].close
          const dollarChange = endPrice - startPrice
          const percentChange = ((endPrice - startPrice) / startPrice) * 100
          const dailyChanges = data.map(d => d.close - d.open)
          const avgDailyChange = dailyChanges.reduce((a, b) => a + b, 0) / dailyChanges.length
          setMetrics({ dollarChange, percentChange, avgDailyChange })
        }
      } else {
        console.error('Historical API failed')
      }
    } catch (err) {
      console.error('Historical fetch failed', err)
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <header className="text-center mb-12">
          <h1 className="text-5xl font-bold text-gray-800 mb-2">Money Go Up</h1>
          <p className="text-lg text-gray-600">Track your favorite stocks in real-time</p>
        </header>
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
        {loading && (
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            <p className="mt-4 text-lg text-gray-600">Loading stock data...</p>
          </div>
        )}
        {stockData && !stockData.error && (
          <div className="bg-white p-8 rounded-2xl shadow-2xl">
            <h2 className="text-3xl font-bold text-gray-800 mb-6 text-center">
              {stockData.symbol || stockData.name || selectedTicker}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-xl text-black shadow-lg border-1 border-blue-600">
                <div className="text-sm font-medium opacity-80">Last Price</div>
                <div className="text-2xl font-bold">{stockData.last || stockData.close || stockData.tngoLast ||'Coming Soon'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl text-black shadow-lg border-1 border-blue-600">
                <div className="text-sm font-medium opacity-80">Open</div>
                <div className="text-2xl font-bold">{stockData.open || 'Coming Soon'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl text-black shadow-lg border-1 border-blue-600">
                <div className="text-sm font-medium opacity-80">High</div>
                <div className="text-2xl font-bold">{stockData.high || 'Coming Soon'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl text-black shadow-lg border-1 border-blue-600">
                <div className="text-sm font-medium opacity-80">Low</div>
                <div className="text-2xl font-bold">{stockData.low || 'Coming Soon'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl text-black shadow-lg border-1 border-blue-600">
                <div className="text-sm font-medium opacity-80">Volume</div>
                <div className="text-2xl font-bold">{stockData.volume || 'Coming Soon'}</div>
              </div>
              <div className="bg-white p-6 rounded-xl text-black shadow-lg border-1 border-blue-600">
                <div className="text-sm font-medium opacity-80">Previous Close</div>
                <div className="text-2xl font-bold">{stockData.prevClose || 'Coming Soon'}</div>
              </div>
            </div>
          </div>
        )}
        {stockData && !stockData.error && (
          <div className="bg-white p-8 rounded-2xl shadow-2xl mt-8">
            <h3 className="text-3xl font-bold text-gray-800 mb-6 text-center">Historical Data</h3>
            <div className="flex justify-center space-x-4 mb-6">
              <button onClick={() => fetchHistoricalData(selectedTicker, '1M')} className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition duration-200 shadow-lg">1 Month</button>
              <button onClick={() => fetchHistoricalData(selectedTicker, '6M')} className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition duration-200 shadow-lg">6 Months</button>
              <button onClick={() => fetchHistoricalData(selectedTicker, '1Y')} className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition duration-200 shadow-lg">1 Year</button>
            </div>
            {historicalLoading && (
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                <p className="mt-2 text-gray-600">Loading historical data...</p>
              </div>
            )}
            {historicalData && (
              <div>
                {'error' in historicalData ? (
                  <p className="text-center text-red-500">{historicalData.error}</p>
                ) : Array.isArray(historicalData) && historicalData.length > 0 && metrics ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-white p-6 rounded-xl text-black shadow-lg text-center border-1 border-blue-600">
                      <div className="text-sm font-medium opacity-80">Dollar Change</div>
                      <div className="text-2xl font-bold">{metrics.dollarChange.toFixed(2)}</div>
                    </div>
                    <div className="bg-white p-6 rounded-xl text-black shadow-lg text-center border-1 border-blue-600">
                      <div className="text-sm font-medium opacity-80">Percent Change</div>
                      <div className="text-2xl font-bold">{metrics.percentChange.toFixed(2)}%</div>
                    </div>
                    <div className="bg-white p-6 rounded-xl text-black shadow-lg text-center border-1 border-blue-600">
                      <div className="text-sm font-medium opacity-80">Avg Daily Change</div>
                      <div className="text-2xl font-bold">{metrics.avgDailyChange.toFixed(2)}</div>
                    </div>
                  </div>
                ) : (
                  <p className="text-center text-gray-500">No historical data available for this period.</p>
                )}
              </div>
            )}
          </div>
        )}
        {stockData && stockData.error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-xl text-center shadow-lg">
            <strong className="font-bold">Error:</strong> <span className="block sm:inline">Failed to fetch data for {selectedTicker}. Please try again.</span>
          </div>
        )}
      </div>
    </div>
  )
}