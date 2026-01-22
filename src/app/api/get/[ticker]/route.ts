// src/app/api/get/[ticker]/route.ts
import { NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';

export async function GET(request: Request, { params }: { params: { ticker: string } }) {
  let connection;
  try {
    const ticker = params.ticker.toUpperCase();
    const userId = 1; // Hardcoded user_id as per existing convention

    connection = await getDbConnection();

    // First, check if the stock is on the user's watchlist and get stock info
    const [stockWatchlistResults]: any = await connection.execute(
      `SELECT s.id, s.symbol, s.company_name, s.price, us.shares, us.purchase_price
       FROM stocks s
       JOIN user_stocks us ON s.id = us.stock_id
       WHERE us.user_id = ? AND s.symbol = ?`,
      [userId, ticker]
    );

    if (stockWatchlistResults.length === 0) {
      await connection.end();
      return NextResponse.json({ message: 'Stock not found on watchlist' }, { status: 404 });
    }

    const stockInfo = stockWatchlistResults[0];

    // If on watchlist, fetch all historical data for that stock
    const [historicalDataResults]: any = await connection.execute(
      `SELECT * FROM stocksdailyprice WHERE stock_id = ? ORDER BY date DESC`,
      [stockInfo.id]
    );

    await connection.end();

    const responseData = {
      ...stockInfo,
      historicalData: historicalDataResults,
    };

    return NextResponse.json(responseData, { status: 200 });

  } catch (error) {
    console.error(`Failed to fetch data for ticker ${params.ticker}:`, error);
    if (connection) {
      await connection.end();
    }
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Failed to fetch stock data', details: errorMessage }, { status: 500 });
  }
}
