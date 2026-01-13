// src/app/api/dashboard/route.ts
import { NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';

export async function GET() {
  let connection;
  try {
    connection = await getDbConnection();

    // This query fetches the most recent daily price for each stock.
    const query = `
        SELECT
            s.symbol,
            s.company_name,
            sdp.date,
            sdp.open,
            sdp.high,
            sdp.low,
            sdp.close,
            sdp.volume
        FROM stocks s
        LEFT JOIN (
            SELECT
                stock_id,
                MAX(date) AS max_date
            FROM stocksdailyprice
            GROUP BY stock_id
        ) latest ON s.id = latest.stock_id
        LEFT JOIN stocksdailyprice sdp ON latest.stock_id = sdp.stock_id AND latest.max_date = sdp.date
        ORDER BY s.symbol;
    `;

    const [rows] = await connection.execute(query);
    await connection.end();

    // -- DEBUGGING STEP --
    // Log the first raw row from the database to the server console.
    if (Array.isArray(rows) && rows.length > 0) {
      console.log('--- DEBUG: First database row ---');
      console.log((rows as any[])[0]);
      console.log('---------------------------------');
    }
    // -- END DEBUGGING STEP --

    const data = (rows as any[]).map(row => ({
      symbol: row.symbol,
      companyName: row.company_name, // Explicitly map from the original column name
      date: row.date,
      open: row.open ? parseFloat(row.open) : null,
      high: row.high ? parseFloat(row.high) : null,
      low: row.low ? parseFloat(row.low) : null,
      close: row.close ? parseFloat(row.close) : null,
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
