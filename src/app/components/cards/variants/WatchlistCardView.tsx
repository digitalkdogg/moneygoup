// src/app/components/cards/variants/WatchlistCardView.tsx

import React from 'react'
import { WatchlistCard, CardActionHandlers } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { CardActions, ActionButton } from '../CardActions'
import { formatPrice, getAnalystColor, formatPercent, calculatePredictionChange, getPredictionColor } from '../formatters'

interface WatchlistCardViewProps {
  card: WatchlistCard
  actions?: CardActionHandlers
}

export const WatchlistCardView: React.FC<WatchlistCardViewProps> = ({ card, actions }) => {
  const analystDisplay = card.analysts ? `${card.analysts} analysts` : 'No analyst data'
  const predictionChange = calculatePredictionChange(card.price, card.predictedPrice1m ?? null)
  const isCompact = card.isCompact

  return (
    <>
      <CardHeader
        symbol={card.symbol}
        companyName={card.companyName}
        changePercent={card.changePercent}
        price={card.price}
        variant="watchlist"
      />
      <div className={isCompact ? "px-3 py-2" : "px-5 py-4"}>
        {card.predictedPrice1m !== null && card.predictedPrice1m !== undefined && (
          <CardMetricRow
            label="1M Target"
            value={
              <div className="text-right">
                <div className={isCompact ? "text-sm" : ""}>{formatPrice(card.predictedPrice1m)}</div>
                {predictionChange !== null && (
                  <div className={`text-[10px] font-normal ${getPredictionColor(predictionChange)}`}>
                    {formatPercent(predictionChange)}
                  </div>
                )}
              </div>
            }
            className={isCompact ? "py-1" : ""}
          />
        )}
        <CardMetricRow
          label="Analyst"
          value={
            <div className="text-right">
              <div className={`${getAnalystColor(card.analystFeedback)} ${isCompact ? "text-sm" : ""}`}>{card.analystFeedback || 'None'}</div>
              <div className="text-[10px] text-gray-400 font-normal">{analystDisplay}</div>
            </div>
          }
          className={isCompact ? "py-1" : ""}
        />
      </div>
      <CardActions compact={isCompact}>
        <ActionButton
          label={isCompact ? "Add" : "Add to Portfolio"}
          variant="primary"
          size={isCompact ? "sm" : undefined}
          outline={isCompact}
          onClick={(e) => actions?.onAddToPortfolio?.(card.symbol)}
        />
        <ActionButton
          label={isCompact ? "Remove" : "Remove"}
          variant="secondary"
          size={isCompact ? "sm" : undefined}
          outline={isCompact}
          onClick={(e) => actions?.onRemoveFromWatchlist?.(card.symbol)}
        />
      </CardActions>
    </>
  )
}
