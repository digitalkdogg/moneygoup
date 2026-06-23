// src/app/components/cards/variants/PortfolioCardView.tsx

import React from 'react'
import { PortfolioCard, CardActionHandlers } from '../types'
import {
  formatPrice,
  formatShares,
  formatPercent,
  formatPriceChange,
  getChangeColor,
  getPredictionColor,
  calculatePredictionChange,
} from '../formatters'
import { GpsTooltip } from '../GpsTooltip'
import { BrandLogo } from '../BrandLogo'
import { GpsCallLabel } from '../../GpsCallLabel'

interface PortfolioCardViewProps {
  card: PortfolioCard
  actions?: CardActionHandlers
}

// Downside-flag tuning. Goal: cut false alarms on mildly-negative predictions,
// especially near 52-week highs where the model tends to mean-revert.
const DOWNSIDE_MILD_PCT = -3   // anything >= -3% is treated as noise
const DOWNSIDE_STRONG_PCT = -6 // <= -6% always flags, regardless of context
const NEAR_52W_HIGH_RATIO = 0.95 // within 5% of 52w high

const shouldFlagDownside = (
  predictionChange: number | null,
  currentPrice: number | null,
  fiftyTwoWeekHigh: number | null | undefined
): boolean => {
  if (predictionChange == null) return false
  if (predictionChange >= DOWNSIDE_MILD_PCT) return false
  if (predictionChange <= DOWNSIDE_STRONG_PCT) return true
  // Moderate range: suppress if stock is near its 52-week high
  if (currentPrice != null && fiftyTwoWeekHigh != null && fiftyTwoWeekHigh > 0) {
    if (currentPrice / fiftyTwoWeekHigh >= NEAR_52W_HIGH_RATIO) return false
  }
  return true
}

export const PortfolioCardView: React.FC<PortfolioCardViewProps> = ({ card }) => {
  const predictionChange = calculatePredictionChange(card.price, card.predictedPriceHorizon ?? null)
  const showDownsideFlag = shouldFlagDownside(predictionChange, card.price, card.fiftyTwoWeekHigh)
  const perShareChange = card.changeAmount != null && card.sharesHeld
    ? card.changeAmount / card.sharesHeld
    : null
  const horizonLabel = card.horizonLabel ?? '1M'

  return (
    <>
      {card.topAccentColor && (
        <div style={{ backgroundColor: card.topAccentColor }} className="h-1 rounded-t-2xl" />
      )}

      {/* Header: logo | symbol + name | price + change */}
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <BrandLogo
          ticker={card.symbol}
          logoSvg={card.logo}
          brandColor={card.topAccentColor}
          size={40}
        />
        <div className="flex-1 min-w-0">
          <div className="text-xl font-bold text-gray-900 leading-none">{card.symbol}</div>
          <div className="text-xs text-gray-500 font-medium mt-1 truncate">
            {card.companyName}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          {card.price != null && (
            <div className="text-lg font-bold text-gray-900 leading-none">{formatPrice(card.price)}</div>
          )}
          {card.changePercent != null && (
            <div className={`text-[11px] font-semibold ${getChangeColor(card.changePercent)}`}>
              {perShareChange != null
                ? `${formatPriceChange(perShareChange)} (${formatPercent(card.changePercent)})`
                : formatPercent(card.changePercent)}
            </div>
          )}
        </div>
      </div>

      {/* Metrics: SHARES | GPS SCORE | ANALYST */}
      <div className="px-4 pb-3 grid grid-cols-3 gap-3">
        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Shares</div>
          <div className="text-sm font-bold text-gray-900">{formatShares(card.sharesHeld)}</div>
        </div>

        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">GPS Score</div>
          {card.gpsScore != null ? (
            <div className="flex items-center gap-1">
              <span className="text-sm font-bold text-gray-900">{card.gpsScore.toFixed(1)}</span>
              <GpsTooltip score={card.gpsScore} breakdown={card.gpsBreakdown} symbol={card.symbol} horizon={card.gpsHorizon} variant="card" />
            </div>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Rating</div>
          <GpsCallLabel score={card.gpsScore ?? null} showScore={false} />
          {card.analystFeedback && (
            <div className="text-[10px] text-gray-400 mt-0.5 truncate">Analysts: {card.analystFeedback}</div>
          )}
        </div>
      </div>

      {/* Footer: horizon pred line + chevron (or downside warning) */}
      <div className="mt-auto border-t border-gray-100 px-4 py-2 flex items-center justify-between">
        <div className="text-xs text-gray-600">
          <span className="font-medium">{horizonLabel} pred </span>
          <span className="font-bold text-gray-900">
            {card.predictedPriceHorizon != null ? formatPrice(card.predictedPriceHorizon) : '—'}
          </span>
          {predictionChange != null && (
            <span className={`ml-1 font-semibold ${getPredictionColor(predictionChange)}`}>
              {predictionChange > 0 ? '+' : ''}{predictionChange.toFixed(1)}%
            </span>
          )}
        </div>
        {showDownsideFlag ? (
          <span
            className="inline-flex items-center text-red-600"
            aria-label="AI model predicts downside"
            title="AI model predicts downside"
          >
            <svg className="w-4 h-4" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d="M6 1L1 10h10L6 1z" fillOpacity="0" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M6 4.5v3M6 9h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </svg>
          </span>
        ) : (
          <svg className="w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M7.293 4.293a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        )}
      </div>
    </>
  )
}
