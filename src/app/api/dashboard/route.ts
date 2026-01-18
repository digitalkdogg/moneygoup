// src/app/api/dashboard/route.ts
import { NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';
import { calculateTechnicalIndicators, HistoricalData } from '@/utils/technicalIndicators';

interface DailyPriceRow {
  stock_id: number;
  date: string;
  close: string;
  volume: string;
  open: string;
  high: string;
  low: string;
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
            COALESCE(us.shares, 0) AS shares,
            COALESCE(us.purchase_price, 0) AS purchase_price,
            CASE WHEN us.is_purchased = TRUE THEN TRUE ELSE FALSE END AS is_owned,
            spd.close AS prev_close_price
        FROM stocks s
        LEFT JOIN user_stocks us ON s.id = us.stock_id AND us.user_id = ?
        LEFT JOIN (
            SELECT
                stock_id,
                MAX(date) AS max_date
            FROM stocksdailyprice
            WHERE date <= CURDATE()
            GROUP BY stock_id
        ) latest_price_date ON s.id = latest_price_date.stock_id
        LEFT JOIN stocksdailyprice spd ON latest_price_date.stock_id = spd.stock_id AND latest_price_date.max_date = spd.date
        ORDER BY s.symbol;
    `, [userId]);

    // 2. Fetch all historical prices, ordered by date for each stock
    const [pricesResult] = await connection.execute(`
        SELECT stock_id, date, \`close\`, volume, \`open\`, \`high\`, \`low\`
        FROM stocksdailyprice
        ORDER BY stock_id, date ASC;
    `);
    const dailyPrices = pricesResult as DailyPriceRow[];

    // 3. Fetch news data for the user's stocks
    const [newsResult] = await connection.execute(`
        SELECT
            usn.stock_id,
            n.sentiment_score,
            n.pub_date
        FROM user_stock_news usn
        JOIN news n ON usn.news_id = n.id
        JOIN user_stocks us ON usn.user_id = us.user_id AND usn.stock_id = us.stock_id
        WHERE usn.user_id = ?
        ORDER BY n.pub_date DESC;
    `, [userId]);
    const newsData = newsResult as any[]; // Type as any for now

    await connection.end();

    // 3. Group prices by stock_id
    const pricesByStockId = dailyPrices.reduce((acc, row) => {
      const { stock_id, date, close, volume, open, high, low } = row;
      if (!acc[stock_id]) {
        acc[stock_id] = [];
      }
      acc[stock_id].push({
        date,
        close: parseFloat(close),
        volume: parseInt(volume, 10),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
      });
      return acc;
    }, {} as Record<string, HistoricalData[]>);

    // 4. Group news by stock_id
    const newsByStockId = newsData.reduce((acc, row) => {
      const { stock_id, sentiment_score, pub_date } = row;
      if (!acc[stock_id]) {
        acc[stock_id] = [];
      }
      acc[stock_id].push({ sentiment_score: parseFloat(sentiment_score), pub_date: pub_date });
      return acc;
    }, {} as Record<string, { sentiment_score: number; pub_date: string }[]>);

    // 5. Combine data and perform calculations
    const data = (stocks as any[]).map(stock => {
      const stockPrices = pricesByStockId[stock.id] || [];
      const stockNews = newsByStockId[stock.id] || []; // Get news for the current stock
      const indicators = calculateTechnicalIndicators(stockPrices, stockNews);

      const currentPrice = parseFloat(stock.price || '0');
      const shares = parseFloat(stock.shares);
      const prevClosePrice = parseFloat(stock.prev_close_price || '0');
      
      let estimatedDailyEarnings = 0;
      if (stock.is_owned === 1 && currentPrice && prevClosePrice && shares > 0) {
        estimatedDailyEarnings = (currentPrice - prevClosePrice) * shares;
      }

      return {
        stock_id: stock.id,
        symbol: stock.symbol,
        companyName: stock.company_name,
        price: currentPrice,
        recommendation: indicators.signal,
        volatility: indicators.volatility,
        isOwned: stock.is_owned === 1, // Convert TINYINT(1) to boolean
        shares: shares,
        purchase_price: parseFloat(stock.purchase_price || '0'),
        estimatedDailyEarnings: estimatedDailyEarnings,
        source: ['DATABASE'],
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
