'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { trackTrendingStockClick } from '@/utils/analytics'
import StockCard from './cards/StockCard'
import { SearchTrendingCard } from './cards/types'

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

export default function TrendingStocksGrid() {
  const router = useRouter()
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

  const mapToCardModel = (stock: TrendingStock): SearchTrendingCard => ({
    variant: 'search-trending',
    symbol: stock.symbol,
    companyName: stock.companyName,
    price: stock.price,
    changePercent: stock.changePercent,
    hotRating: stock.trendScore
  })

  const handleCardClick = (symbol: string) => {
    const stock = stocks.find(s => s.symbol === symbol)
    trackTrendingStockClick(symbol, stock?.trendScore || null)
    router.push(`/search/${symbol}`)
  }

  return (
    <div className="w-full">
      <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
        Trending (Last 48 Hours)
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {displayStocks.slice(0, 12).map((stock, idx) => (
          stock.price === null ? (
            <TrendingSkeleton key={`skeleton-${idx}`} />
          ) : (
            <StockCard
              key={stock.symbol}
              card={mapToCardModel(stock)}
              actions={{ onCardClick: handleCardClick }}
            />
          )
        ))}
      </div>
    </div>
  )
}
