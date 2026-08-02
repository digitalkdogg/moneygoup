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
import { GpsCallLabel } from '../../GpsCallLabel'
import { RiskGrowthTags } from '../RiskGrowthTags'

interface WatchlistCardViewProps {
  card: WatchlistCard
  actions?: CardActionHandlers
  onClick?: () => void
}

export const WatchlistCardView: React.FC<WatchlistCardViewProps> = ({ card, onClick }) => {
  const predictionChange = calculatePredictionChange(card.price, card.predictedPriceHorizon ?? null)
  const horizonLabel = card.horizonLabel ?? '1M'

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
      className="w-full h-full bg-white border border-gray-200 rounded-[10px] px-[18px] pt-2.5 pb-2 cursor-pointer hover:shadow-[0_4px_16px_rgba(0,0,0,0.09)] hover:border-gray-300 hover:-translate-y-1 transition-all duration-200 flex flex-col gap-1.5 focus-ring"
    >
      {/* Header: ticker + company | price + change */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-[18px] font-bold text-gray-900 tracking-wide leading-tight">{card.symbol}</span>
            <RiskGrowthTags gpsScore={card.gpsScore} predictedChangePct={predictionChange} size="xs" />
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

      {/* Stats: GPS | Analyst */}
      <div className="grid grid-cols-2 gap-1.5">
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
            Rating
          </div>
          <GpsCallLabel score={card.gpsScore ?? null} showScore={false} />
          {card.analystFeedback && (
            <div className="text-[10px] text-gray-400 mt-0.5 truncate">
              Analysts: {card.analystFeedback}
              {card.analysts != null && card.analysts > 0 && ` (${card.analysts})`}
            </div>
          )}
        </div>

      </div>

      <div className="h-px bg-gray-100 mt-auto" />

      {/* Footer: horizon pred + arrow */}
      <div className="flex items-center justify-between">
        <div className="text-[14px] leading-tight">
          <span className="text-[12px] text-gray-500 font-semibold mr-1.5">{horizonLabel} Pred</span>
          {card.predictedPriceHorizon != null ? (
            <>
              <span className="font-bold text-gray-900">{formatPrice(card.predictedPriceHorizon)}</span>
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
        <div className="text-gray-500 text-xl leading-none" aria-hidden="true">›</div>
      </div>
    </div>
  )
}
