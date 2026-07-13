'use client'

import { useState, useEffect } from 'react'
import { getMarketStatus } from '@/utils/marketStatus'

interface IndexData {
  symbol: string
  label: string
  price: number | null
  change: number | null
  changePercent: number | null
  asOf: string | null
}

const SKELETON_INDICES: IndexData[] = [
  { symbol: '^DJI', label: 'Dow Jones', price: null, change: null, changePercent: null, asOf: null },
  { symbol: '^GSPC', label: 'S&P 500', price: null, change: null, changePercent: null, asOf: null },
  { symbol: '^IXIC', label: 'Nasdaq', price: null, change: null, changePercent: null, asOf: null },
  { symbol: '^VIX', label: 'VIX', price: null, change: null, changePercent: null, asOf: null },
]

function IndexSkeleton() {
  return (
    <div className="p-4 bg-[#fbf9fa] border border-gray-200 rounded-2xl shadow-md animate-pulse">
      <div className="h-4 bg-gray-200 rounded w-24 mb-2"></div>
      <div className="h-6 bg-gray-200 rounded w-32 mb-2"></div>
      <div className="h-4 bg-gray-200 rounded w-20"></div>
    </div>
  )
}

function IndexCard({ index }: { index: IndexData }) {
  const isLoading = index.price === null
  const isPositive = (index.changePercent ?? 0) >= 0

  if (isLoading) {
    return <IndexSkeleton />
  }

  const priceStr = index.price ? index.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A'
  const changeStr = index.change !== null ? (index.change >= 0 ? '+' : '') + index.change.toFixed(2) : 'N/A'
  const percentStr = index.changePercent !== null ? (index.changePercent >= 0 ? '+' : '') + index.changePercent.toFixed(2) + '%' : 'N/A'

  return (
    <div 
      className="p-4 bg-[#fbf9fa] border border-gray-200 rounded-2xl shadow-md"
      role="region"
      aria-label={`${index.label}: $${priceStr}, ${percentStr}`}
    >
      <div className="text-sm font-medium text-gray-500 mb-1">
        {index.label}
      </div>
      <div className="text-lg font-bold text-gray-900 mb-2">
        ${priceStr}
      </div>
      <div className={`text-sm font-semibold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
        <span aria-hidden="true">{isPositive ? '↑' : '↓'}</span>
        {' '}{changeStr} ({percentStr})
      </div>
    </div>
  )
}

export default function MajorIndicesStrip() {
  const [indices, setIndices] = useState<IndexData[]>(SKELETON_INDICES)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchIndices = async () => {
      try {
        const response = await fetch('/api/market/indices')
        if (!response.ok) {
          throw new Error('Failed to fetch indices')
        }
        const data = await response.json()
        setIndices(data.indices || SKELETON_INDICES)
      } catch (err) {
        console.error('Error fetching indices:', err)
        setError('Market data temporarily unavailable')
        // Keep skeleton state visible
      }
    }

    // Always fetch once on mount so the strip is populated even outside
    // market hours (showing the last close). Then only poll while the
    // market is open — indices don't move overnight or on weekends, so
    // post-close polling is wasted Yahoo + DB load.
    fetchIndices()
    if (!getMarketStatus().isOpen) return
    const interval = setInterval(fetchIndices, 2 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  if (error) {
    return (
      <div className="w-full">
        <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg section-major-indices">
          <h2 className="section-heading">Major Indices</h2>
          <div className="p-4 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800">
            {error}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <div className="rounded-2xl section-market-overview">
        <h2 className="section-heading">Market Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {indices.map(index => (
            <IndexCard key={index.symbol} index={index} />
          ))}
        </div>
      </div>
    </div>
  )
}
