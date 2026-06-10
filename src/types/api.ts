/**
 * API response types for type-safe endpoint handlers
 */

export interface ApiSuccessResponse<T = unknown> {
  status: 'success';
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  status: 'error' | 'fail';
  message: string;
  correlationId?: string;
  errors?: Record<string, string[]>;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface StockQuoteResponse {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  timestamp: string;
}

export interface PortfolioSummaryResponse {
  totalValue: number;
  totalCost: number;
  totalGain: number;
  totalGainPercent: number;
  stocks: Array<{
    id: number;
    symbol: string;
    name: string;
    shares: number;
    purchasePrice: number;
    currentPrice: number | null;
    value: number;
    gain: number;
    gainPercent: number;
  }>;
}

export interface PredictionResponse {
  symbol: string;
  predictedPrice: number;
  confidence: number;
  timestamp: string;
  modelVersion: string;
}

export interface ProfileStats {
  lookupCount: number;
  portfolioItemCount: number;
  watchlistItemCount: number;
}

export type InvestmentTimeframe = '1_week' | '1_month' | '6_month' | '1_year';

export interface ProfileStrategy {
  aggressiveness: 'safe' | 'neutral' | 'aggressive';
  investment_timeframe: InvestmentTimeframe;
}

export type ProfileResponse =
  | { username: string; accountType: 'user' | 'superuser'; stats: ProfileStats; strategy: ProfileStrategy }
  | { username: string; accountType: 'admin'; strategy: ProfileStrategy };
