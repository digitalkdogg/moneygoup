/**
 * Database row types - matches schema definitions
 * These interfaces prevent "any" type usage and ensure type safety
 */

export interface StockRow {
  id: number;
  symbol: string;
  company_name: string;
  price: number | null;
  marketcap: number | null;
  pe_ratio: number | null;
  dividend_yield: number | null;
}

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserStockRow {
  user_id: string;
  stock_id: number;
  shares: number;
  purchase_price: number;
  average_cost_basis: number | null;
  first_purchase_date: string | null;
  purchase_date: string;
  is_purchased: number; // 1 = in portfolio, 0 = watchlist
  updated_at: string;
}

export interface PortfolioTransactionRow {
  id: number;
  user_id: number;
  stock_id: number;
  transaction_type: 'buy' | 'sell' | 'dividend' | 'split' | 'deposit' | 'withdrawal';
  shares: number | null;
  price_per_share: number | null;
  total_amount: number;
  fees: number;
  transaction_date: string;
  notes: string | null;
  created_at: string;
}

export interface PortfolioSnapshotRow {
  user_id: number;
  snapshot_date: string;
  portfolio_value: number;
  total_cost_basis: number;
  unrealized_gain_loss: number;
  realized_gain_loss: number;
  daily_change_amount: number | null;
  daily_change_percent: number | null;
  created_at: string;
}

export interface PortfolioPositionHistoryRow {
  user_id: number;
  stock_id: number;
  snapshot_date: string;
  shares: number;
  market_value: number;
  cost_basis: number;
}

export interface PortfolioBenchmarkRow {
  user_id: number;
  snapshot_date: string;
  portfolio_return_pct: number;
  spy_return_pct: number;
  alpha_pct: number;
}

export interface UserStockWithDetailsRow extends UserStockRow {
  symbol: string;
  company_name: string;
  price: number | null;
}

export interface PredictionRow {
  id: number;
  user_id: string;
  stock_id: number;
  prediction_date: string;
  predicted_price: number;
  confidence: number;
  model_version: string;
  created_at: string;
}

export interface WatchlistRow {
  user_id: string;
  stock_id: number;
  added_date: string;
  notes: string | null;
}

export interface WatchlistWithDetailsRow extends WatchlistRow {
  symbol: string;
  company_name: string;
  price: number | null;
}

export interface UserStockPredictionRow {
  id: number;
  user_id: string;
  stock_id: number;
  predicted_price_1m: number;
  last_requested_at: string;
  created_at: string;
  updated_at: string;
}
