/**
 * Dashboard widget specific types
 */

export interface MarketIndexItem {
  symbol: string;
  label: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  asOf: string;
}

export interface MarketOverviewResponse {
  indices: MarketIndexItem[];
  asOf: string;
}

export interface PortfolioTotals {
  costBasis: number;
  marketValue: number;
  unrealizedGain: number;
  unrealizedLoss: number;
  unrealizedNet: number;
  unrealizedPct: number;
}

export interface PortfolioWithTotalsResponse {
  portfolio: import('./portfolio').PortfolioItem[];
  totals: PortfolioTotals;
  ratings?: AnalystRatingItem[];
  asOf?: string;
}

export interface DashboardRecommendation {
  stockId: number;
  symbol: string;
  action: 'BUY' | 'SELL';
  currentPrice: number;
  predictedPrice1m: number;
  deltaPct: number;
  gpsScore: number | null;
  gpsBreakdown: any | null;
  lastRequestedAt: string;
  scope: 'portfolio' | 'watchlist' | 'discovery';
}

export interface DashboardRecommendationsResponse {
  recommendations: DashboardRecommendation[];
  asOf: string;
}

export interface AnalystRatingItem {
  symbol: string;
  primary: string; // Strong Buy, Buy, Hold, Sell, Strong Sell
  score: number | null;
  count: number | null;
}

export interface AnalystRatingsResponse {
  ratings: AnalystRatingItem[];
  asOf: string;
}
