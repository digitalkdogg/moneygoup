// src/app/components/cards/variants/SearchTrendingCardView.tsx

import React from 'react'
import { SearchTrendingCard } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { formatPrice } from '../formatters'

interface SearchTrendingCardViewProps {
  card: SearchTrendingCard
}

export const SearchTrendingCardView: React.FC<SearchTrendingCardViewProps> = ({ card }) => {
  return (
    <>
      <CardHeader 
        symbol={card.symbol} 
        companyName={card.companyName} 
        changePercent={card.changePercent} 
      />
      <div className="px-5 py-4">
        <CardMetricRow label="Price" value={formatPrice(card.price)} />
        <CardMetricRow 
          label="Hot Rating" 
          value={card.hotRating !== null ? card.hotRating.toFixed(0) : 'N/A'} 
          valueClassName="text-blue-600"
        />
      </div>
    </>
  )
}
