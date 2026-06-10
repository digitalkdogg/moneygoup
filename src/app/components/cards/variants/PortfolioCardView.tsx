// src/app/components/cards/variants/PortfolioCardView.tsx

import React from 'react'
import { PortfolioCard, CardActionHandlers } from '../types'
import { CardHeader } from '../CardHeader'
import { CardActions, ActionButton } from '../CardActions'
import { formatPrice, formatShares, formatPercent, getPredictionColor, calculatePredictionChange } from '../formatters'
import { GpsTooltip } from '../GpsTooltip'

interface PortfolioCardViewProps {
  card: PortfolioCard
  actions?: CardActionHandlers
}

export const PortfolioCardView: React.FC<PortfolioCardViewProps> = ({ card, actions }) => {
  const predictionChange = calculatePredictionChange(card.price, card.predictedPrice1m ?? null)
  // Per-share daily dollar change for the header display
  const perShareChange = card.changeAmount != null && card.sharesHeld
    ? card.changeAmount / card.sharesHeld
    : null

  const analystBadgeClass = card.analystFeedback?.toLowerCase().includes('strong buy')
    ? 'bg-green-100 text-green-700 border-green-200'
    : card.analystFeedback?.toLowerCase().includes('buy')
    ? 'bg-blue-50 text-blue-600 border-blue-100'
    : 'bg-gray-100 text-gray-600 border-gray-200'

  return (
    <>
      {card.topAccentColor && (
        <div style={{ backgroundColor: card.topAccentColor }} className="h-1 rounded-t-2xl" />
      )}
      <CardHeader
        symbol={card.symbol}
        companyName={card.companyName}
        changePercent={card.changePercent}
        changeAmount={perShareChange}
        price={card.price}
        variant="portfolio"
      />

      <div className="mx-5 border-t border-gray-100" />

      {/* Horizontal metrics: SHARES | GPS SCORE | ANALYST */}
      <div className="px-5 py-2 grid grid-cols-3 gap-3">
        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Shares</div>
          <div className="text-sm font-bold text-gray-900">{formatShares(card.sharesHeld)}</div>
        </div>

        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">GPS Score</div>
          {card.gpsScore != null ? (
            <div className="flex items-center gap-1">
              <span className="text-sm font-bold text-gray-900">{card.gpsScore.toFixed(1)}</span>
              <GpsTooltip score={card.gpsScore} breakdown={card.gpsBreakdown} symbol={card.symbol} horizon={card.gpsHorizon} />
            </div>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Analyst</div>
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold border ${card.analystFeedback ? analystBadgeClass : 'bg-gray-100 text-gray-400 border-gray-200'}`}>
            {card.analystFeedback ?? 'None'}
          </span>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {card.analysts ? `${card.analysts} analysts` : ' '}
          </div>
        </div>
      </div>

      {/* Predicted 1M row — always rendered to keep all cards the same height */}
      <div className="mx-5 border-t border-gray-100" />
      <div className="px-5 py-1.5 flex items-center gap-3">
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Predicted 1M</div>
        <div className="flex items-center gap-2">
          {card.predictedPrice1m != null ? (
            <>
              <span className="text-sm font-bold text-gray-900">{formatPrice(card.predictedPrice1m)}</span>
              {predictionChange != null && (
                <span className={`text-[13px] font-semibold ${getPredictionColor(predictionChange)}`}>
                  ({predictionChange > 0 ? '+' : ''}{predictionChange.toFixed(1)}%)
                </span>
              )}
            </>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>
      </div>

      <CardActions justify={predictionChange != null && predictionChange < 0 ? 'between' : 'end'} compact>
        {predictionChange != null && predictionChange < 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-red-50 border border-red-200 text-red-600 text-[11px] font-semibold leading-tight whitespace-nowrap">
            <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d="M6 1L1 10h10L6 1z" fillOpacity="0" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M6 4.5v3M6 9h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
            </svg>
            AI model predicts downside
          </span>
        )}
        <div className="flex gap-2">
          <ActionButton
            label="Buy More"
            ariaLabel={`Buy more shares of ${card.symbol}`}
            variant="primary"
            size="sm"
            grow={false}
            onClick={(e) => actions?.onBuyMore?.(card.symbol)}
          />
          <ActionButton
            label="Sell"
            ariaLabel={`Sell shares of ${card.symbol}`}
            variant="secondary"
            size="sm"
            grow={false}
            onClick={(e) => actions?.onSell?.(card.symbol)}
          />
        </div>
      </CardActions>
    </>
  )
}
