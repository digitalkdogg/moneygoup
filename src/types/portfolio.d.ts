// src/types/portfolio.d.ts
export interface PortfolioItem {
  user_id?: number;
  stock_id: number;
  symbol: string;
  company_name: string;
  name?: string;
  shares: number;
  purchase_price: number;
  average_cost_basis?: number | null;
  first_purchase_date?: string | null;
  predicted_price_1m?: number | string | null;
  initial_purchase_date?: string;
  last_transaction_date?: string;
  regularMarketPrice: number;
  prev_close?: number;
  recommendationKey?: string | null;
  numberOfAnalystOpinions?: number | null;
  brand_color?: string | null;
  gpsScore?: number | null;
  gpsBreakdown?: any | null;
  sector?: string | null;
  [key: string]: any; // For StockTableRow compatibility
}
