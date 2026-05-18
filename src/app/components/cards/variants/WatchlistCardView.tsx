// src/app/components/cards/variants/WatchlistCardView.tsx

import React from 'react'
import { WatchlistCard, CardActionHandlers } from '../types'
import { CardHeader } from '../CardHeader'
import { CardActions, ActionButton } from '../CardActions'
import { formatPrice, calculatePredictionChange, getPredictionColor } from '../formatters'
import { GpsTooltip } from '../GpsTooltip'

interface WatchlistCardViewProps {
  card: WatchlistCard
  actions?: CardActionHandlers
}

export const WatchlistCardView: React.FC<WatchlistCardViewProps> = ({ card, actions }) => {
  const predictionChange = calculatePredictionChange(card.price, card.predictedPrice1m ?? null)

  const analystBadgeClass = card.analystFeedback?.toLowerCase().includes('strong buy')
    ? 'bg-green-100 text-green-700 border-green-200'
    : card.analystFeedback?.toLowerCase().includes('buy')
    ? 'bg-blue-50 text-blue-600 border-blue-100'
    : 'bg-gray-100 text-gray-600 border-gray-200'

  return (
    <>
      <CardHeader
        symbol={card.symbol}
        companyName={card.companyName}
        changePercent={card.changePercent}
        changeAmount={card.changeAmount}
        price={card.price}
        variant="watchlist"
      />

      {/* Row 1: GPS Score | Analyst */}
      <div className="px-4 pt-2 pb-1 grid grid-cols-2 gap-3">
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

      {/* Row 2: MA 6M | Predicted 1M */}
      <div className="px-4 pb-0 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">MA 6M</div>
          <span className="text-sm font-bold text-gray-900">
            {card.ma6m != null ? formatPrice(card.ma6m) : '—'}
          </span>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Predicted 1M</div>
          <div className="flex items-center gap-1.5 flex-wrap">
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
      </div>

      <CardActions justify="end" compact>
        <ActionButton
          label="Add to Portfolio"
          ariaLabel={`Add ${card.symbol} to your portfolio`}
          variant="primary"
          size="sm"
          grow={false}
          onClick={(e) => actions?.onAddToPortfolio?.(card.symbol)}
        />
        <ActionButton
          label="Remove"
          ariaLabel={`Remove ${card.symbol} from watchlist`}
          variant="neutral"
          size="sm"
          grow={false}
          onClick={(e) => actions?.onRemoveFromWatchlist?.(card.symbol)}
        />
      </CardActions>
    </>
  )
}
