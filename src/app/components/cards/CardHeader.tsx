// src/app/components/cards/CardHeader.tsx

import React from 'react'
import { formatPercent, getChangeColor, getChangeBg, getChangeBgStyle, formatPrice } from './formatters'

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
      <div className="flex items-start justify-between px-5 py-3 border-b border-gray-200">
        <div>
          <div className="text-2xl font-bold text-gray-900 leading-tight">
            {symbol}
          </div>
          <div className="text-xs text-gray-500 font-medium mt-1 truncate max-w-[140px]">
            {companyName}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {changePercent !== null && (
            <div
              style={getChangeBgStyle(changePercent)}
              className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1 ${getChangeColor(changePercent)} ${getChangeBg(changePercent)} bg-opacity-10`}
            >
              <span aria-hidden="true">{isPositive ? '↑' : '↓'}</span>
              {formatPercent(changePercent)}
            </div>
          )}
          {price !== null && price !== undefined && (
            <div className="text-lg font-bold text-gray-900">
              {formatPrice(price)}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start justify-between px-5 py-3 border-b border-gray-200">
      <div>
        <div className="text-2xl font-bold text-gray-900 leading-tight">
          {symbol}
        </div>
        <div className="text-xs text-gray-500 font-medium mt-1 truncate max-w-[140px]">
          {companyName}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div 
          style={brandColor ? { 
            backgroundColor: `${brandColor}3A`, // 4D is ~0.3 opacity in hex
            color: brandColor,
          } : {}}
          className={`px-2 py-0.5 rounded ${!brandColor ? 'bg-gray-100 text-gray-700' : ''} text-[10px] font-bold uppercase`}
        >
          {symbol}
        </div>
        {changePercent !== null && (
          <div className={`text-sm font-bold ${getChangeColor(changePercent)}`}>
            {isPositive ? '+' : ''}{formatPercent(changePercent)}
          </div>
        )}
      </div>
    </div>
  )
}
