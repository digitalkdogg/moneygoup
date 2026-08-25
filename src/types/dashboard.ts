/**
 * Dashboard widget specific types
 */
import type { HorizonKey } from '@/utils/horizons';

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
  gpsHorizon?: HorizonKey;
  lastRequestedAt: string;
  scope: 'portfolio' | 'watchlist' | 'discovery' | 'etf_holding' | 'off_market_mover';
  etfTicker?: string;         // set when scope === 'etf_holding'
  offMarketChangePct?: number; // set when scope === 'off_market_mover'
  offMarketLabel?: string;     // 'Pre-Market' | 'After-Hours'
  /** Days this ticker has been on the dashboard; from dashboard_tenure.
   *  Drives the "NEW" badge (≤3 days) and — for discovery / etf_holding —
   *  eligibility for the fresh pool when tenure rotation is on. */
  consecutiveDays?: number | null;
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
