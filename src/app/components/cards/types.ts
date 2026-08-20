import React from 'react'

export type CardVariant = 'search-trending' | 'deepmoney' | 'portfolio' | 'watchlist'

export interface CardBase {
  symbol: string
  companyName: string
  price: number | null
  changePercent: number | null
  changeAmount?: number | null
}

export interface SearchTrendingCard extends CardBase {
  variant: 'search-trending'
  hotRating: number | null
  /** GPS score (0-100) sourced from stock_gps_scores, optionally horizon-patched. */
  gpsScore?: number | null
  gpsBreakdown?: any | null
  analystFeedback?: string | null
  analysts?: number | null
  ma6m?: number | null
  /** Predicted price for the user's chosen horizon (1W/1M/6M/1Y). */
  predictedPriceHorizon?: number | null
  /** Compact horizon label rendered on the card, e.g. "1M" or "6M". */
  horizonLabel?: string
}

export interface DeepmoneyCard extends CardBase {
  variant: 'deepmoney'
  prediction: 'Bullish' | 'Bearish' | 'Neutral' | number | null
  gpsScore: number | null
  gpsBreakdown?: any | null
  /** Free-text label appended to the prediction row, e.g. "in 6 months". */
  timeframeLabel?: string | null
  /** Which prediction horizon the breakdown reflects (defaults to 1_month). */
  gpsHorizon?: '1_week' | '1_month' | '6_month' | '1_year'
  /** Days this ticker has consecutively appeared on the dashboard. Sourced
   *  from dashboard_tenure. Drives the "NEW" badge on cards ≤ 3 days old. */
  consecutiveDays?: number | null
  /** Set when this card surfaces as an off-market mover (pre or after-hours). */
  offMarketMover?: { marketState: 'PRE' | 'POST'; changePct: number } | null
}

export interface PortfolioCard extends CardBase {
  variant: 'portfolio'
  sharesHeld: number | null
  /** Original per-share purchase price (or average cost basis if the user has
   *  multiple lots). Rendered next to sharesHeld as "N.NN × $XX.XX". */
  purchasePrice?: number | null
  analystFeedback: string | null
  analysts?: number | null
  gpsScore?: number | null
  gpsBreakdown?: any | null
  /** Which prediction horizon the breakdown reflects (defaults to 1_month). */
  gpsHorizon?: '1_week' | '1_month' | '6_month' | '1_year'
  topAccentColor?: string
  /** Predicted price for the user's chosen horizon (1W/1M/6M/1Y). */
  predictedPriceHorizon?: number | null
  /** Compact horizon label rendered on the card, e.g. "1M" or "6M". */
  horizonLabel?: string
  fiftyTwoWeekHigh?: number | null
  logo?: string | null
}

export interface WatchlistCard extends CardBase {
  variant: 'watchlist'
  analystFeedback: string | null
  analysts?: number | null
  ma6m: number | null
  gpsScore?: number | null
  gpsBreakdown?: any | null
  /** Which prediction horizon the breakdown reflects (defaults to 1_month). */
  gpsHorizon?: '1_week' | '1_month' | '6_month' | '1_year'
  isCompact?: boolean
  /** Predicted price for the user's chosen horizon (1W/1M/6M/1Y). */
  predictedPriceHorizon?: number | null
  /** Compact horizon label rendered on the card, e.g. "1M" or "6M". */
  horizonLabel?: string
}

export type StockCardModel =
  | SearchTrendingCard
  | DeepmoneyCard
  | PortfolioCard
  | WatchlistCard

export interface CardActionHandlers {
  onCardClick?: (symbol: string) => void
  onBuyMore?: (symbol: string) => void
  onSell?: (symbol: string) => void
  onAddToPortfolio?: (symbol: string) => void
  onRemoveFromWatchlist?: (symbol: string) => void
}
