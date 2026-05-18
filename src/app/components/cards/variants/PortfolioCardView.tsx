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
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Shares</div>
          <div className="text-sm font-bold text-gray-900">{formatShares(card.sharesHeld)}</div>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">GPS Score</div>
          {card.gpsScore != null ? (
            <div className="flex items-center gap-1">
              <span className="text-sm font-bold text-gray-900">{card.gpsScore.toFixed(1)}</span>
              <GpsTooltip score={card.gpsScore} breakdown={card.gpsBreakdown} symbol={card.symbol} />
            </div>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        <div>
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Analyst</div>
          <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold border ${card.analystFeedback ? analystBadgeClass : 'bg-gray-100 text-gray-400 border-gray-200'}`}>
            {card.analystFeedback ?? 'None'}
          </span>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {card.analysts ? `${card.analysts} analysts` : ' '}
          </div>
        </div>
      </div>

      {/* Predicted 1M row — always rendered to keep all cards the same height */}
      <div className="mx-5 border-t border-gray-100" />
      <div className="px-5 py-1.5 flex items-center gap-3">
        <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">Predicted 1M</div>
        <div className="flex items-center gap-2">
          {card.predictedPrice1m != null ? (
            <>
              <span className="text-sm font-bold text-gray-900">{formatPrice(card.predictedPrice1m)}</span>
              {predictionChange != null && (
                <span className={`text-xs font-semibold ${getPredictionColor(predictionChange)}`}>
                  ({predictionChange > 0 ? '+' : ''}{predictionChange.toFixed(1)}%)
                </span>
              )}
            </>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>
      </div>

      <CardActions justify="end" compact>
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
      </CardActions>
    </>
  )
}
