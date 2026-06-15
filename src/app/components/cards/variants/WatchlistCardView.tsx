// src/app/components/cards/variants/WatchlistCardView.tsx

import React from 'react'
import { WatchlistCard, CardActionHandlers } from '../types'
import {
  formatPrice,
  formatPriceChange,
  formatPercent,
  getChangeColor,
  calculatePredictionChange,
  getPredictionColor,
} from '../formatters'

interface WatchlistCardViewProps {
  card: WatchlistCard
  actions?: CardActionHandlers
  onClick?: () => void
}

const analystBadgeClasses = (feedback: string | null | undefined): string => {
  const f = feedback?.toLowerCase() ?? ''
  if (f.includes('strong buy')) return 'bg-green-100 text-green-700'
  if (f.includes('buy')) return 'bg-blue-100 text-blue-700'
  if (f.includes('hold')) return 'bg-yellow-100 text-amber-800'
  if (f.includes('strong sell')) return 'bg-red-100 text-red-700'
  if (f.includes('sell')) return 'bg-red-50 text-red-600'
  return 'bg-gray-100 text-gray-500'
}

export const WatchlistCardView: React.FC<WatchlistCardViewProps> = ({ card, onClick }) => {
  const predictionChange = calculatePredictionChange(card.price, card.predictedPrice1m ?? null)
  const analystLabel = card.analystFeedback ?? 'None'
  const ma6mPositive = card.ma6m != null && card.ma6m > 0

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className="w-full bg-white border border-gray-200 rounded-[10px] px-[18px] pt-4 pb-3.5 cursor-pointer hover:shadow-[0_4px_16px_rgba(0,0,0,0.09)] hover:border-gray-300 transition-all duration-150 flex flex-col gap-2.5 focus-ring"
    >
      {/* Header: ticker + company | price + change */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[18px] font-bold text-gray-900 tracking-wide leading-tight">
            {card.symbol}
          </div>
          <div className="text-[13px] font-semibold text-gray-500 mt-0.5 truncate">
            {card.companyName}
          </div>
        </div>
        <div className="text-right">
          {card.price !== null && card.price !== undefined && (
            <div className="text-[18px] font-bold text-gray-900 leading-tight">
              {formatPrice(card.price)}
            </div>
          )}
          {card.changePercent !== null && (
            <div className={`text-[13px] font-semibold mt-0.5 ${getChangeColor(card.changePercent)}`}>
              {card.changeAmount !== null && card.changeAmount !== undefined
                ? `${formatPriceChange(card.changeAmount)} (${formatPercent(card.changePercent)})`
                : formatPercent(card.changePercent)}
            </div>
          )}
        </div>
      </div>

      <div className="h-px bg-gray-100" />

      {/* Stats: GPS | Analyst | MA 6M */}
      <div className="grid grid-cols-3 gap-1.5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 mb-1">
            GPS Score
          </div>
          <div className={`text-[14px] font-semibold ${card.gpsScore != null ? 'text-gray-900' : 'text-gray-400 font-medium'}`}>
            {card.gpsScore != null ? card.gpsScore.toFixed(1) : '—'}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 mb-1">
            Analyst
          </div>
          <span className={`inline-block text-[12px] font-bold tracking-[0.03em] px-1.5 py-0.5 rounded ${analystBadgeClasses(card.analystFeedback)}`}>
            {analystLabel}
          </span>
          {card.analysts != null && card.analysts > 0 && (
            <div className="text-[12px] text-gray-600 mt-0.5">
              {card.analysts} analyst{card.analysts === 1 ? '' : 's'}
            </div>
          )}
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 mb-1">
            MA 6M
          </div>
          <div className={`text-[14px] ${ma6mPositive ? 'font-semibold text-gray-900' : 'font-medium text-gray-600'}`}>
            {card.ma6m != null ? formatPrice(card.ma6m) : '—'}
          </div>
        </div>
      </div>

      <div className="h-px bg-gray-100" />

      {/* Footer: 1M Pred + arrow */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[12px] text-gray-500 font-semibold">1M Pred</div>
          <div className="text-[14px] font-bold text-gray-900 leading-tight">
            {card.predictedPrice1m != null ? (
              <>
                {formatPrice(card.predictedPrice1m)}
                {predictionChange != null && (
                  <span className={`text-[13px] font-semibold ml-1 ${getPredictionColor(predictionChange)}`}>
                    {predictionChange > 0 ? '+' : ''}{predictionChange.toFixed(1)}%
                  </span>
                )}
              </>
            ) : (
              <span className="text-gray-400 font-medium">—</span>
            )}
          </div>
        </div>
        <div className="text-gray-500 text-xl leading-none" aria-hidden="true">›</div>
      </div>
    </div>
  )
}
