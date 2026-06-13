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
}

export interface PortfolioCard extends CardBase {
  variant: 'portfolio'
  sharesHeld: number | null
  analystFeedback: string | null
  analysts?: number | null
  gpsScore?: number | null
  gpsBreakdown?: any | null
  /** Which prediction horizon the breakdown reflects (defaults to 1_month). */
  gpsHorizon?: '1_week' | '1_month' | '6_month' | '1_year'
  topAccentColor?: string
  predictedPrice1m?: number | null // Added predictedPrice1m
  fiftyTwoWeekHigh?: number | null
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
  predictedPrice1m?: number | null // Added predictedPrice1m
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
