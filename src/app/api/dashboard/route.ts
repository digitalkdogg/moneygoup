// src/app/api/dashboard/route.ts
import { NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';

export async function GET() {
  let connection;
  try {
    connection = await getDbConnection();

    // This query fetches the symbol, company name, price, and latest volume for each stock.
    const query = `
        SELECT
            s.symbol,
            s.company_name,
            s.price,
            (
                SELECT sdp.volume
                FROM stocksdailyprice sdp
                WHERE sdp.stock_id = s.id
                ORDER BY sdp.date DESC
                LIMIT 1
            ) AS volume
        FROM stocks s
        ORDER BY s.symbol;
    `;

    const [rows] = await connection.execute(query);
    await connection.end();

    const data = (rows as any[]).map(row => ({
      symbol: row.symbol,
      companyName: row.company_name,
      price: row.price ? parseFloat(row.price) : null,
      volume: row.volume ? parseInt(row.volume, 10) : null,
    }));

    return NextResponse.json(data);

  } catch (error) {
    console.error("Failed to fetch dashboard data:", error);
    // End the connection in case of an error
    if (connection) {
      await connection.end();
    }
    return NextResponse.json({ error: 'Failed to fetch dashboard data' }, { status: 500 });
  }
}