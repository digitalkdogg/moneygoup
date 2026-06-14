// src/app/components/cards/CardHeader.tsx

import React from 'react'
import { formatPercent, formatPriceChange, getChangeColor, getChangeBg, getChangeBgStyle, formatPrice } from './formatters'

interface CardHeaderProps {
  symbol: string
  companyName: string
  changePercent: number | null
  changeAmount?: number | null
  price?: number | null
  variant?: 'watchlist' | 'portfolio'
  brandColor?: string
}

export const CardHeader: React.FC<CardHeaderProps> = ({ symbol, companyName, changePercent, changeAmount, price, variant = 'portfolio', brandColor }) => {
  const isPositive = (changePercent ?? 0) >= 0

  if (variant === 'watchlist') {
    return (
      <div className="flex items-start justify-between px-4 py-2 border-b border-gray-100">
        <div>
          <div className="text-xl font-bold text-gray-900 leading-tight">
            {symbol}
          </div>
          <div className="text-xs text-gray-600 font-semibold mt-1 truncate max-w-[200px]">
            {companyName}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          {price !== null && price !== undefined && (
            <div className="text-lg font-bold text-gray-900">{formatPrice(price)}</div>
          )}
          {changePercent !== null && (
            <div
              className={`text-[13px] font-semibold text-right ${getChangeColor(changePercent)}`}
              aria-label={`Price ${isPositive ? 'up' : 'down'} by ${formatPercent(changePercent)}`}
            >
              {changeAmount !== null && changeAmount !== undefined
                ? `${formatPriceChange(changeAmount)} (${formatPercent(changePercent)})`
                : formatPercent(changePercent)}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start justify-between px-5 py-1">
      <div>
        <div className="text-2xl font-bold text-gray-900 leading-none">
          {symbol}
        </div>
        <div className="text-xs text-gray-600 font-semibold mt-1 truncate max-w-[160px]">
          {companyName}
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        {price !== null && price !== undefined && (
          <div className="text-xl font-bold text-gray-900">{formatPrice(price)}</div>
        )}
        {changePercent !== null && (
          <div
            className={`text-[13px] font-semibold ${getChangeColor(changePercent)}`}
            aria-label={`Price ${isPositive ? 'up' : 'down'} by ${formatPercent(changePercent)}`}
          >
            {changeAmount !== null && changeAmount !== undefined
              ? `${formatPriceChange(changeAmount)} (${formatPercent(changePercent)})`
              : formatPercent(changePercent)}
          </div>
        )}
      </div>
    </div>
  )
}
