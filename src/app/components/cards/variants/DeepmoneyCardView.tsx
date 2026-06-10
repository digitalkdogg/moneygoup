// src/app/components/cards/variants/DeepmoneyCardView.tsx

import React from 'react'
import { DeepmoneyCard } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { formatPrice, formatPercent } from '../formatters'
import { GpsTooltip } from '../GpsTooltip'

interface DeepmoneyCardViewProps {
  card: DeepmoneyCard
}

export const DeepmoneyCardView: React.FC<DeepmoneyCardViewProps> = ({ card }) => {
  const isNumeric = typeof card.prediction === 'number'

  const getPredictionColor = (pred: string | number | null) => {
    if (pred === null || pred === undefined) return 'text-gray-500'
    if (typeof pred === 'number') {
      return pred >= 0 ? 'text-green-600' : 'text-red-600'
    }
    if (pred === 'Bullish') return 'text-green-600'
    if (pred === 'Bearish') return 'text-red-600'
    return 'text-amber-600'
  }

  const displayValue = isNumeric
    ? formatPercent(card.prediction as number)
    : (card.prediction || 'N/A')

  // Append the user's timeframe label to the prediction row when present,
  // e.g. "Predicted Growth in 6 months".
  const predictionLabel = isNumeric ? 'Predicted Growth' : 'Prediction'
  const predictionLabelWithTimeframe = card.timeframeLabel
    ? `${predictionLabel} ${card.timeframeLabel}`
    : predictionLabel

  return (
    <>
      <CardHeader
        symbol={card.symbol}
        companyName={card.companyName}
        changePercent={card.changePercent}
        changeAmount={card.changeAmount}
      />
      <div className="px-5 py-4">
        <CardMetricRow label="Price" value={formatPrice(card.price)} />
        <CardMetricRow
          label={predictionLabelWithTimeframe}
          value={displayValue}
          valueClassName={getPredictionColor(card.prediction)}
        />
        <CardMetricRow 
          label={
            <div className="flex items-center gap-1">
              GPS Score 
              <GpsTooltip score={card.gpsScore} breakdown={card.gpsBreakdown} symbol={card.symbol} horizon={card.gpsHorizon} />
            </div>
          } 
          value={
            card.gpsScore !== null && typeof card.gpsScore === 'number' 
              ? card.gpsScore.toFixed(1) 
              : 'N/A'
          } 
          valueClassName="text-purple-600 font-bold text-right"
        />
      </div>
    </>
  )
}
