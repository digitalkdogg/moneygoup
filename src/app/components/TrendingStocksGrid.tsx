'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { trackTrendingStockClick } from '@/utils/analytics'

interface TrendingStock {
  symbol: string
  companyName: string
  price: number | null
  changePercent: number | null
  trendScore: number | null
  source: string
}

function TrendingSkeleton() {
  return (
    <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 animate-pulse">
      <div className="h-5 bg-gray-200 dark:bg-gray-700 rounded w-16 mb-2"></div>
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-24 mb-3"></div>
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-20"></div>
    </div>
  )
}

function TrendingCard({ stock }: { stock: TrendingStock }) {
  const router = useRouter()
  const isLoading = stock.price === null
  const isPositive = (stock.changePercent ?? 0) >= 0

  if (isLoading) {
    return <TrendingSkeleton />
  }

  const priceStr = stock.price ? stock.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A'
  const percentStr = stock.changePercent !== null ? (stock.changePercent >= 0 ? '+' : '') + stock.changePercent.toFixed(2) + '%' : 'N/A'

  const handleClick = () => {
    trackTrendingStockClick(stock.symbol, stock.trendScore)
    router.push(`/search/${stock.symbol}`)
  }

  return (
    <button
      onClick={handleClick}
      className="text-left p-4 rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-green-500 dark:hover:border-green-400 hover:bg-green-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 transition duration-200 transform hover:scale-105"
      aria-label={`${stock.symbol}: ${stock.companyName}, $${priceStr}, ${percentStr}`}
    >
      <div className="flex justify-between items-start mb-2">
        <div>
          <div className="text-lg font-bold text-gray-900 dark:text-white">
            {stock.symbol}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 line-clamp-1">
            {stock.companyName}
          </div>
        </div>
        {stock.trendScore !== null && (
          <div className="text-xs font-semibold bg-blue-100 dark:bg-blue-900 text-blue-900 dark:text-blue-100 px-2 py-1 rounded whitespace-nowrap">
            {stock.trendScore.toFixed(0)}
          </div>
        )}
      </div>
      <div className="flex justify-between items-end">
        <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          ${priceStr}
        </div>
        <div className={`text-sm font-semibold flex items-center gap-1 ${isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          <span aria-hidden="true">{isPositive ? '↑' : '↓'}</span>
          {percentStr}
        </div>
      </div>
    </button>
  )
}

export default function TrendingStocksGrid() {
  const [stocks, setStocks] = useState<TrendingStock[]>(Array(12).fill({ symbol: '', companyName: '', price: null, changePercent: null, trendScore: null, source: '' }))
  const [error, setError] = useState<string | null>(null)
  const [hasData, setHasData] = useState(false)

  useEffect(() => {
    const fetchTrendingStocks = async () => {
      try {
        const response = await fetch('/api/market/trending?window=48h&limit=12')
        if (!response.ok) {
          throw new Error('Failed to fetch trending stocks')
        }
        const data = await response.json()
        setStocks(data.stocks || [])
        setHasData(data.stocks && data.stocks.length > 0)
        if (!data.stocks || data.stocks.length === 0) {
          setError('No trending data available')
        }
      } catch (err) {
        console.error('Error fetching trending stocks:', err)
        setError('Unable to load trending stocks')
        setHasData(false)
      }
    }

    fetchTrendingStocks()
    // Refresh every 15 minutes
    const interval = setInterval(fetchTrendingStocks, 15 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  if (error && !hasData) {
    return (
      <div className="w-full">
        <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
          Trending (Last 48 Hours)
        </h2>
        <div className="p-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200">
          {error}
        </div>
      </div>
    )
  }

  const displayStocks = hasData ? stocks : Array(12).fill({ symbol: '', companyName: '', price: null, changePercent: null, trendScore: null, source: '' })

  return (
    <div className="w-full">
      <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
        Trending (Last 48 Hours)
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {displayStocks.slice(0, 12).map((stock, idx) => (
          <TrendingCard
            key={stock.symbol || `skeleton-${idx}`}
            stock={stock}
          />
        ))}
      </div>
    </div>
  )
}
