'use client'

import { ReactNode } from 'react'

export interface ApiError {
  type: 'stock' | 'historical'
  ticker: string
  message: string
  details?: string
  failedServices?: string[]
}

interface ApiErrorDisplayProps {
  error: ApiError
  onRetryStock?: () => void
  onRetryHistorical?: () => void
  selectedTicker?: string
}

export default function ApiErrorDisplay({
  error,
  onRetryStock,
  onRetryHistorical,
  selectedTicker
}: ApiErrorDisplayProps) {
  return (
      <div className="bg-red-50 border-2 border-red-400 rounded-xl shadow-lg overflow-hidden mb-8 max-w-6xl mx-auto">
        <div className="bg-red-600 text-white px-6 py-4 font-bold text-lg flex items-center">
          <span className="text-2xl mr-3">⚠️</span>
          API Error
        </div>
        <div className="px-6 py-6 text-gray-800">
          <div className="mb-4">
            <p className="font-bold text-red-700 text-lg mb-2">{error.message}</p>
            <p className="text-sm text-gray-700">
              <span className="font-semibold">Stock Symbol:</span> {error.ticker}
            </p>
            {error.failedServices && error.failedServices.length > 0 && (
              <p className="text-sm text-gray-700 mt-2">
                <span className="font-semibold">Failed Services:</span> {error.failedServices.join(', ')}
              </p>
            )}
          </div>

          {error.details && (
            <div className="bg-red-100 border-l-4 border-red-600 rounded px-4 py-3 mb-4">
              <p className="text-xs font-mono text-gray-800 break-words">
                <span className="font-semibold">Details:</span> {error.details}
              </p>
            </div>
          )}

          <div className="bg-white-50 rounded px-4 py-3">
            <p className="text-sm font-semibold mb-2">💡 What to do:</p>
            <ul className="text-sm space-y-1 list-disc list-inside">
              <li>Check your internet connection</li>
              <li>Verify that your network allows access to Tiingo and 12Data APIs</li>
              <li>If behind a corporate firewall, contact your network administrator</li>
              <li>Try a different stock symbol</li>
              <li>Wait a moment and try again</li>
            </ul>
          </div>

          <div className="mt-4 flex gap-3">
            {onRetryStock && (
              <button
                onClick={onRetryStock}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded-lg transition duration-200"
              >
                🔄 Retry Stock Data
              </button>
            )}
            {selectedTicker && onRetryHistorical && (
              <button
                onClick={onRetryHistorical}
                className="flex-1 bg-green-700 hover:bg-green-800 text-white font-semibold py-2 px-4 rounded-lg transition duration-200"
              >
                📊 Retry Historical Data
              </button>
            )}
          </div>
        </div>
      </div>
  )
}