// src/app/components/cards/types.ts

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
}

export interface PortfolioCard extends CardBase {
  variant: 'portfolio'
  sharesHeld: number | null
  analystFeedback: string | null
  analysts?: number | null
  predictedPrice1m?: number | null
}

export interface WatchlistCard extends CardBase {
  variant: 'watchlist'
  analystFeedback: string | null
  analysts?: number | null
  ma6m: number | null
  predictedPrice1m?: number | null
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
