'use client'

import React from 'react'
import { getCardCallLabel, getCardBadgeClass } from '@/utils/gps'

interface GpsCallLabelProps {
  /** Horizon-adjusted GPS score the calling card has already resolved.
   *  Null renders the "—" placeholder for stocks the sector-leader sync
   *  hasn't yet covered. */
  score: number | null
  /** When true (default) the numeric score is appended after the label
   *  (e.g. "Buy · 62"). Important inside the wide 20-pt Buy band so users
   *  can distinguish a 56 from a 74. Disable only when space is tight. */
  showScore?: boolean
  /** 'sm' (default) for inside cards. 'md' bumps the font + padding for
   *  contexts where the badge is the primary call-to-action. */
  size?: 'sm' | 'md'
}

/**
 * Card-only GPS Buy/Sell badge. Renders the variant-B label
 * (Strong Sell / Sell / Hold / Buy / Strong Buy at 25/45/55/75 thresholds)
 * and a color ramp aligned to those bands.
 *
 * Used by PortfolioCardView, WatchlistCardView, and SearchTrendingCardView
 * — these surfaces show a more decisive Buy/Sell call than the canonical
 * `getGpsLabel` (used by recommendations engine, /search/industry/[sector],
 * the stock detail GPS panel, and DeepMoney picks). See `src/utils/gps.ts`
 * for the rationale on the two label functions.
 */
export const GpsCallLabel: React.FC<GpsCallLabelProps> = ({ score, showScore = true, size = 'sm' }) => {
  const label = getCardCallLabel(score)
  const classes = getCardBadgeClass(score)

  const sizeClasses =
    size === 'md'
      ? 'text-sm font-bold px-3 py-1'
      : 'text-xs font-bold px-2 py-0.5'

  return (
    <span className={`inline-block rounded border ${sizeClasses} ${classes}`}>
      {label}
      {showScore && score !== null && (
        <span className="ml-1.5 opacity-80 font-semibold">{score.toFixed(1)}</span>
      )}
    </span>
  )
}

export default GpsCallLabel
