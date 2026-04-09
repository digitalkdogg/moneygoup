// src/app/components/cards/variants/PortfolioCardView.tsx

import React from 'react'
import { PortfolioCard, CardActionHandlers } from '../types'
import { CardHeader } from '../CardHeader'
import { CardMetricRow } from '../CardMetricRow'
import { CardActions, ActionButton } from '../CardActions'
import { formatPrice, formatShares, getAnalystColor } from '../formatters'

interface PortfolioCardViewProps {
  card: PortfolioCard
  actions?: CardActionHandlers
}

export const PortfolioCardView: React.FC<PortfolioCardViewProps> = ({ card, actions }) => {
  const analystDisplay = card.analysts ? `${card.analysts} analysts` : 'No analyst data'

  return (
    <>
      <CardHeader 
        symbol={card.symbol} 
        companyName={card.companyName} 
        changePercent={card.changePercent} 
        changeAmount={card.changeAmount} 
      />
      <div className="px-5 py-0">
        <CardMetricRow label="Shares Held" value={formatShares(card.sharesHeld)} />
        <CardMetricRow label="Price" value={formatPrice(card.price)} />
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
          label="Buy More" 
          variant="primary" 
          onClick={(e) => actions?.onBuyMore?.(card.symbol)} 
        />
        <ActionButton 
          label="Sell" 
          variant="secondary" 
          onClick={(e) => actions?.onSell?.(card.symbol)} 
        />
      </CardActions>
    </>
  )
}
