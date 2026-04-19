// src/app/components/cards/variants/WatchlistCardView.tsx

import React from 'react'
import { WatchlistCard, CardActionHandlers } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { CardActions, ActionButton } from '../CardActions'
import { formatPrice, getAnalystColor, formatPercent, calculatePredictionChange, getPredictionColor, formatPriceChange } from '../formatters'

interface WatchlistCardViewProps {
  card: WatchlistCard
  actions?: CardActionHandlers
}

export const WatchlistCardView: React.FC<WatchlistCardViewProps> = ({ card, actions }) => {
  const analystDisplay = card.analysts ? `${card.analysts} analysts` : 'No analyst data'
  const predictionChange = calculatePredictionChange(card.price, card.predictedPrice1m)

  return (
    <>
      <CardHeader 
        symbol={card.symbol} 
        companyName={card.companyName} 
        changePercent={card.changePercent} 
        changeAmount={card.changeAmount}
      />
      <div className="px-5 py-4">
        <CardMetricRow 
          label="Price" 
          value={
            <div className="text-right">
              <div>{formatPrice(card.price)}</div>
              {card.changeAmount !== undefined && card.changeAmount !== null && (
                <div className={`text-[10px] font-normal ${getPredictionColor(card.changeAmount)}`}>
                  {formatPriceChange(card.changeAmount)}
                </div>
              )}
            </div>
          } 
        />
        {card.predictedPrice1m !== null && card.predictedPrice1m !== undefined && (
          <CardMetricRow 
            label="1M Prediction" 
            value={
              <div className="text-right">
                <div>{formatPrice(card.predictedPrice1m)}</div>
                {predictionChange !== null && (
                  <div className={`text-[10px] font-normal ${getPredictionColor(predictionChange)}`}>
                    {formatPercent(predictionChange)}
                  </div>
                )}
              </div>
            } 
          />
        )}
        <CardMetricRow 
          label="Analyst" 
          value={
            <div className="text-right">
              <div className={getAnalystColor(card.analystFeedback)}>{card.analystFeedback || 'None'}</div>
              <div className="text-[10px] text-gray-400 font-normal">{analystDisplay}</div>
            </div>
          }
        />
      </div>
      <CardActions>
        <ActionButton 
          label="Add to Portfolio" 
          variant="primary" 
          onClick={(e) => actions?.onAddToPortfolio?.(card.symbol)} 
        />
        <ActionButton 
          label="Remove" 
          variant="secondary" 
          onClick={(e) => actions?.onRemoveFromWatchlist?.(card.symbol)} 
        />
      </CardActions>
    </>
  )
}
