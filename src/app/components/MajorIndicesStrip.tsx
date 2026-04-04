'use client'

import { useState, useEffect } from 'react'

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
]

function IndexSkeleton() {
  return (
    <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 animate-pulse">
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-24 mb-2"></div>
      <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-32 mb-2"></div>
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-20"></div>
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
      className="p-4 rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-green-300 dark:hover:border-green-500 transition duration-200 transform hover:scale-105"
      role="region"
      aria-label={`${index.label}: $${priceStr}, ${percentStr}`}
    >
      <div className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
        {index.label}
      </div>
      <div className="text-lg font-bold text-gray-900 dark:text-white mb-2">
        ${priceStr}
      </div>
      <div className={`text-sm font-semibold ${isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
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

    fetchIndices()
    // Refresh every 2 minutes
    const interval = setInterval(fetchIndices, 2 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  if (error) {
    return (
      <div className="w-full">
        <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
          Major Indices
        </h2>
        <div className="p-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
        Major Indices
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {indices.map(index => (
          <IndexCard key={index.symbol} index={index} />
        ))}
      </div>
    </div>
  )
}
