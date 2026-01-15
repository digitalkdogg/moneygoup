// src/app/api/dashboard/route.ts
import { NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';
import { calculateAnnualizedVolatility, getVolatilityRating, HistoricalPrice } from '@/utils/volatility';

interface DailyPriceRow {
  stock_id: number;
  date: string;
  close: string;
  volume: string;
}

export async function GET() {
  let connection;
  try {
    connection = await getDbConnection();

    // For now, we'll hardcode the user_id to 1 as there is no auth system
    const userId = 1;

    // 1. Fetch all stocks with an is_owned flag
    const [stocks] = await connection.execute(`
        SELECT
            s.id,
            s.symbol,
            s.company_name,
            s.price,
            CASE WHEN us.stock_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_owned
        FROM stocks s
        LEFT JOIN user_stocks us ON s.id = us.stock_id AND us.user_id = ?
        ORDER BY s.symbol;
    `, [userId]);

    // 2. Fetch all historical prices, ordered by date for each stock
    const [pricesResult] = await connection.execute(`
        SELECT stock_id, date, \`close\`, volume
        FROM stocksdailyprice
        ORDER BY stock_id, date ASC;
    `);
    const dailyPrices = pricesResult as DailyPriceRow[];

    await connection.end();

    // 3. Group prices by stock_id
    const pricesByStockId = dailyPrices.reduce((acc, row) => {
      const { stock_id, date, close, volume } = row;
      if (!acc[stock_id]) {
        acc[stock_id] = [];
      }
      acc[stock_id].push({ date, close: parseFloat(close), volume: parseInt(volume, 10) });
      return acc;
    }, {} as Record<string, (HistoricalPrice & { volume: number })[]>);

    // 4. Combine data and perform calculations
    const data = (stocks as any[]).map(stock => {
      const stockPrices = pricesByStockId[stock.id] || [];
      
      // Calculate volatility
      const annualizedVolatility = calculateAnnualizedVolatility(stockPrices);
      const volatilityRating = getVolatilityRating(annualizedVolatility);
      
      // Get the latest volume from the last entry
      const latestVolume = stockPrices.length > 0 ? stockPrices[stockPrices.length - 1].volume : null;

      return {
        stock_id: stock.id,
        symbol: stock.symbol,
        companyName: stock.company_name,
        price: stock.price ? parseFloat(stock.price) : null,
        volume: latestVolume,
        volatility: volatilityRating,
        isOwned: stock.is_owned === 1, // Convert TINYINT(1) to boolean
      };
    });

    return NextResponse.json(data);

  } catch (error) {
    console.error("Failed to fetch dashboard data:", error);
    if (connection) {
      await connection.end();
    }
    return NextResponse.json({ error: 'Failed to fetch dashboard data' }, { status: 500 });
  }
}
