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
  dailyChangeAmount: number | null;
  dailyChangePct: number | null;
  realizedGainLoss: number | null;
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
  deltaPct?: number;          // informational only — BUY/SELL logic uses GPS score
  gpsScore: number | null;
  gpsBreakdown: object | null;
  /** Which prediction horizon the GPS reflects (i.e. which delta drove mlpUpside). */
  gpsHorizon?: '1_week' | '1_month' | '6_month' | '1_year';
  lastRequestedAt: string;
  scope: 'portfolio' | 'watchlist' | 'discovery' | 'etf_holding';
  etfTicker?: string;         // set when scope === 'etf_holding'
}

export interface DashboardRecommendationsResponse {
  recommendations: DashboardRecommendation[];
  /** Compact horizon label (e.g. "6M") matching the user's investment_timeframe. */
  horizonLabel?: string;
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
