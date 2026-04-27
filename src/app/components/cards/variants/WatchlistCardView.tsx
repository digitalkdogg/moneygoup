// src/app/components/cards/variants/WatchlistCardView.tsx

import React from 'react'
import { WatchlistCard, CardActionHandlers } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { CardActions, ActionButton } from '../CardActions'
import { formatPrice, getAnalystColor, formatPercent, calculatePredictionChange, getPredictionColor } from '../formatters'
import { GpsTooltip } from '../GpsTooltip'

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
        {card.gpsScore !== null && card.gpsScore !== undefined && (
          <CardMetricRow
            label={
              <div className="flex items-center gap-1">
                GPS Score 
                <GpsTooltip score={card.gpsScore} breakdown={card.gpsBreakdown} symbol={card.symbol} />
              </div>
            }
            value={
              <div className="text-right font-bold text-gray-900">
                {(card.gpsScore !== null && typeof card.gpsScore === 'number') ? card.gpsScore.toFixed(1) : 'N/A'}
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
          ariaLabel={`Add ${card.symbol} to your portfolio`}
          variant="primary"
          size={isCompact ? "sm" : undefined}
          outline={isCompact}
          onClick={(e) => actions?.onAddToPortfolio?.(card.symbol)}
        />
        <ActionButton
          label={isCompact ? "Remove" : "Remove"}
          ariaLabel={`Remove ${card.symbol} from watchlist`}
          variant="secondary"
          size={isCompact ? "sm" : undefined}
          outline={isCompact}
          onClick={(e) => actions?.onRemoveFromWatchlist?.(card.symbol)}
        />
      </CardActions>
    </>
  )
}
