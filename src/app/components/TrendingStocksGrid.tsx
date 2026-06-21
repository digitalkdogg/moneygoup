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
  changeAmount?: number | null
  trendScore: number | null
  gpsScore?: number | null
  gpsBreakdown?: any | null
  analystFeedback?: string | null
  analysts?: number | null
  ma6m?: number | null
  predictedPriceHorizon?: number | null
  source: string
}

function TrendingSkeleton() {
  return (
    <div className="p-4 bg-[#fbf9fa] border border-gray-200 rounded-2xl shadow-md animate-pulse">
      <div className="h-5 bg-gray-200 rounded w-16 mb-2"></div>
      <div className="h-4 bg-gray-200 rounded w-24 mb-3"></div>
      <div className="h-4 bg-gray-200 rounded w-20"></div>
    </div>
  )
}

export default function TrendingStocksGrid() {
  const router = useRouter()
  const [stocks, setStocks] = useState<TrendingStock[]>(Array(12).fill({ symbol: '', companyName: '', price: null, changePercent: null, trendScore: null, source: '' }))
  const [horizonLabel, setHorizonLabel] = useState<string>('1M')
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
        // Sort by GPS score desc; missing scores sink to the bottom so the
        // most-trusted picks always lead the grid.
        const sortedStocks = (data.stocks || []).slice().sort(
          (a: TrendingStock, b: TrendingStock) =>
            (b.gpsScore ?? -Infinity) - (a.gpsScore ?? -Infinity),
        )
        setStocks(sortedStocks)
        if (typeof data?.horizonLabel === 'string') {
          setHorizonLabel(data.horizonLabel)
        }
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
        <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg">
          <h2 className="section-heading">Trending (Last 48 Hours)</h2>
          <div className="p-4 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800">
            {error}
          </div>
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
    changeAmount: stock.changeAmount ?? null,
    hotRating: stock.trendScore,
    gpsScore: stock.gpsScore ?? null,
    gpsBreakdown: stock.gpsBreakdown ?? null,
    analystFeedback: stock.analystFeedback ?? null,
    analysts: stock.analysts ?? null,
    ma6m: stock.ma6m ?? null,
    predictedPriceHorizon: stock.predictedPriceHorizon ?? null,
    horizonLabel,
  })

  const handleCardClick = (symbol: string) => {
    const stock = stocks.find(s => s.symbol === symbol)
    trackTrendingStockClick(symbol, stock?.trendScore || null)
    router.push(`/search/${symbol}`)
  }

  return (
    <div className="w-full">
      <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg">
        <h2 className="section-heading">Trending (Last 48 Hours)</h2>
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
    </div>
  )
}
