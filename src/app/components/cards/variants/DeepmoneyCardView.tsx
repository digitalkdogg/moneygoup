// src/app/components/cards/variants/DeepmoneyCardView.tsx

import React from 'react'
import { DeepmoneyCard } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { formatPrice, formatPercent } from '../formatters'

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
          label={isNumeric ? "Predicted Growth" : "Prediction"} 
          value={displayValue} 
          valueClassName={getPredictionColor(card.prediction)}
        />
        <CardMetricRow 
          label="GPS Score" 
          value={card.gpsScore !== null ? `${card.gpsScore.toFixed(1)}/10` : 'N/A'} 
          valueClassName="text-purple-600"
        />
      </div>
    </>
  )
}
