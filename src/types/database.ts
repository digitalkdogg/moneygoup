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
  created_at: string;
  updated_at: string;
}

export interface UserStockRow {
  user_id: string;
  stock_id: number;
  shares: number;
  purchase_price: number;
  purchase_date: string;
  is_purchased: number; // 1 = in portfolio, 0 = watchlist
  updated_at: string;
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
