// src/app/components/cards/variants/DeepmoneyCardView.tsx
//
// Visually mirrors SearchTrendingCardView so all /search-page cards read as
// one design system: header (ticker/name | price/change), hairline divider,
// stats grid, hairline divider, footer with the headline prediction and a
// chevron affordance.

import React from 'react'
import { DeepmoneyCard } from '../types'
import { GpsTooltip } from '../GpsTooltip'
import {
  formatPrice,
  formatPriceChange,
  formatPercent,
  getChangeColor,
  getPredictionColor,
} from '../formatters'

interface DeepmoneyCardViewProps {
  card: DeepmoneyCard
}

const outlookBadgeClasses = (outlook: 'Bullish' | 'Bearish' | 'Neutral'): string => {
  switch (outlook) {
    case 'Bullish': return 'bg-green-100 text-green-700'
    case 'Bearish': return 'bg-red-100 text-red-700'
    case 'Neutral': return 'bg-yellow-100 text-amber-800'
  }
}

const deriveOutlook = (pred: DeepmoneyCard['prediction']): 'Bullish' | 'Bearish' | 'Neutral' | null => {
  if (pred === null || pred === undefined) return null
  if (typeof pred === 'number') {
    if (pred > 0.5) return 'Bullish'
    if (pred < -0.5) return 'Bearish'
    return 'Neutral'
  }
  return pred
}

export const DeepmoneyCardView: React.FC<DeepmoneyCardViewProps> = ({ card }) => {
  const outlook = deriveOutlook(card.prediction)
  const isNumeric = typeof card.prediction === 'number'
  const predLabel = isNumeric ? 'Predicted Growth' : 'Outlook'
  const predLabelWithTimeframe = card.timeframeLabel
    ? `${predLabel} ${card.timeframeLabel}`
    : predLabel

  return (
    <div className="flex flex-col gap-2.5 px-[18px] pt-4 pb-3.5 h-full">
      {/* Header: ticker + company | price + change */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-[18px] font-bold text-gray-900 tracking-wide leading-tight">
              {card.symbol}
            </div>
            {typeof card.consecutiveDays === 'number' && card.consecutiveDays <= 3 && (
              <span
                className="inline-block text-[9px] font-bold tracking-[0.06em] uppercase px-1.5 py-0.5 rounded bg-green-100 text-green-700 leading-none"
                title={`On dashboard ${card.consecutiveDays} day${card.consecutiveDays === 1 ? '' : 's'}`}
              >
                New
              </span>
            )}
            {card.offMarketMover && (
              <span
                className={`inline-flex items-center gap-0.5 text-[9px] font-bold tracking-[0.05em] uppercase px-1.5 py-0.5 rounded leading-none ${
                  card.offMarketMover.marketState === 'PRE'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-orange-100 text-orange-700'
                }`}
                title={`${card.offMarketMover.marketState === 'PRE' ? 'Pre-Market' : 'After-Hours'}: ${card.offMarketMover.changePct > 0 ? '+' : ''}${card.offMarketMover.changePct.toFixed(2)}%`}
              >
                {card.offMarketMover.marketState === 'PRE' ? 'Pre-Mkt' : 'After-Hrs'}
              </span>
            )}
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
          {card.changePercent !== null && card.changePercent !== undefined && (
            <div className={`text-[13px] font-semibold mt-0.5 ${getChangeColor(card.changePercent)}`}>
              {card.changeAmount !== null && card.changeAmount !== undefined
                ? `${formatPriceChange(card.changeAmount)} (${formatPercent(card.changePercent)})`
                : formatPercent(card.changePercent)}
            </div>
          )}
        </div>
      </div>

      <div className="h-px bg-gray-100" />

      {/* Stats: GPS | Outlook */}
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 mb-1 flex items-center gap-1">
            GPS Score
            <GpsTooltip
              score={card.gpsScore}
              breakdown={card.gpsBreakdown}
              symbol={card.symbol}
              horizon={card.gpsHorizon}
            />
          </div>
          <div className={`text-[14px] font-semibold ${card.gpsScore != null ? 'text-gray-900' : 'text-gray-400 font-medium'}`}>
            {card.gpsScore != null ? card.gpsScore.toFixed(1) : '—'}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 mb-1">
            Outlook
          </div>
          {outlook ? (
            <span className={`inline-block text-[12px] font-bold tracking-[0.03em] px-1.5 py-0.5 rounded ${outlookBadgeClasses(outlook)}`}>
              {outlook}
            </span>
          ) : (
            <span className="text-[14px] text-gray-400 font-medium">—</span>
          )}
        </div>
      </div>

      <div className="h-px bg-gray-100 mt-auto" />

      {/* Footer: prediction headline + chevron */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[14px] leading-tight min-w-0">
          <span className="text-[12px] text-gray-500 font-semibold mr-1.5">{predLabelWithTimeframe}</span>
          {isNumeric ? (
            <span className={`font-bold ${getPredictionColor(card.prediction as number)}`}>
              {(card.prediction as number) > 0 ? '+' : ''}{(card.prediction as number).toFixed(2)}%
            </span>
          ) : outlook ? (
            <span className={`font-bold ${outlook === 'Bullish' ? 'text-green-600' : outlook === 'Bearish' ? 'text-red-600' : 'text-gray-600'}`}>
              {outlook}
            </span>
          ) : (
            <span className="text-gray-400 font-medium">—</span>
          )}
        </div>
        <div className="text-gray-500 text-xl leading-none" aria-hidden="true">›</div>
      </div>
    </div>
  )
}
