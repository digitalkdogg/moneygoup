// src/app/components/cards/StockCard.tsx

import React, { memo } from 'react'
import { StockCardModel, CardActionHandlers } from './types'
import { BaseCardShell } from './BaseCardShell'
import { SearchTrendingCardView } from './variants/SearchTrendingCardView'
import { DeepmoneyCardView } from './variants/DeepmoneyCardView'
import { PortfolioCardView } from './variants/PortfolioCardView'
import { WatchlistCardView } from './variants/WatchlistCardView'

interface StockCardProps {
  card: StockCardModel
  actions?: CardActionHandlers
  className?: string
}

const StockCard: React.FC<StockCardProps> = ({ card, actions, className }) => {
  const handleCardClick = () => {
    if (actions?.onCardClick) {
      actions.onCardClick(card.symbol)
    }
  }

  const renderContent = () => {
    switch (card.variant) {
      case 'search-trending':
        return <SearchTrendingCardView card={card} />
      case 'deepmoney':
        return <DeepmoneyCardView card={card} />
      case 'portfolio':
        return <PortfolioCardView card={card} actions={actions} />
      case 'watchlist':
        return <WatchlistCardView card={card} actions={actions} />
      default:
        return null
    }
  }

  return (
    <BaseCardShell onClick={handleCardClick} className={className}>
      {renderContent()}
    </BaseCardShell>
  )
}

export default memo(StockCard)
