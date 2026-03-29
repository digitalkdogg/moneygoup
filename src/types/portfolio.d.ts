// src/types/portfolio.d.ts
export interface PortfolioItem {
  user_id?: number;
  stock_id: number;
  symbol: string;
  company_name: string;
  name?: string;
  shares: number;
  purchase_price: number;
  initial_purchase_date?: string;
  last_transaction_date?: string;
  regularMarketPrice: number;
  prev_close?: number;
  recommendationKey?: string | null;
  numberOfAnalystOpinions?: number | null;
  [key: string]: any; // For StockTableRow compatibility
}
