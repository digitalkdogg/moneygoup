// src/app/components/cards/variants/PortfolioCardView.tsx

import React from 'react'
import { PortfolioCard, CardActionHandlers } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { CardActions, ActionButton } from '../CardActions'
import { formatPrice, formatShares, formatPriceChange, getPredictionColor, calculatePredictionChange } from '../formatters'
import { GpsTooltip } from '../GpsTooltip'

interface PortfolioCardViewProps {
  card: PortfolioCard
  actions?: CardActionHandlers
}

export const PortfolioCardView: React.FC<PortfolioCardViewProps> = ({ card, actions }) => {
  const analystDisplay = card.analysts ? `${card.analysts} analysts` : 'No analyst data'
  const predictionChange = calculatePredictionChange(card.price, card.predictedPrice1m ?? null)

  return (
    <>
      {card.topAccentColor && (
        <div style={{ backgroundColor: card.topAccentColor }} className="h-1 rounded-t-2xl" />
      )}
      <CardHeader
        symbol={card.symbol}
        companyName={card.companyName}
        changePercent={card.changePercent}
        price={card.price}
        variant="portfolio"
      />
      <div className="px-5 py-0">
        <CardMetricRow label="SHARES" value={formatShares(card.sharesHeld)} />
        <CardMetricRow
          label="PRICE"
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
        {card.gpsScore !== null && card.gpsScore !== undefined && (
          <CardMetricRow
            label={
              <div className="flex items-center gap-1">
                GPS SCORE 
                <GpsTooltip score={card.gpsScore} breakdown={card.gpsBreakdown} symbol={card.symbol} />
              </div>
            }
            value={
              <div className="text-right">
                <div className="font-bold text-gray-900">
                  {typeof card.gpsScore === 'number' ? card.gpsScore.toFixed(1) : card.gpsScore}
                </div>
              </div>
            }
          />
        )}
        <CardMetricRow
          label="ANALYST"
          value={
            <div className="text-right">
              {card.analystFeedback ? (
                <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold border ${
                  card.analystFeedback.toLowerCase().includes('strong buy') 
                    ? 'bg-green-100 text-green-700 border-green-200' 
                    : card.analystFeedback.toLowerCase().includes('buy')
                    ? 'bg-blue-50 text-blue-600 border-blue-100'
                    : 'bg-gray-100 text-gray-600 border-gray-200'
                }`}>
                  {card.analystFeedback}
                </span>
              ) : (
                <span className="text-gray-400">None</span>
              )}
            </div>
          }
        />
      </div>
      <CardActions>
        <ActionButton
          label="Buy More"
          ariaLabel={`Buy more shares of ${card.symbol}`}
          variant="primary"
          onClick={(e) => actions?.onBuyMore?.(card.symbol)}
        />
        <ActionButton
          label="Sell"
          ariaLabel={`Sell shares of ${card.symbol}`}
          variant="secondary"
          onClick={(e) => actions?.onSell?.(card.symbol)}
        />
      </CardActions>
    </>
  )
}
