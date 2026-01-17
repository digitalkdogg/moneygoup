import { NextRequest, NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';

export async function POST(request: NextRequest) {
  try {
    const { ticker, name } = await request.json();

    if (!ticker || !name) {
      return NextResponse.json(
        { status: 'error', message: 'stock_symbol and company_name are required' },
        { status: 400 }
      );
    }

    let connection;
    try {
      connection = await getDbConnection();
      const [result] = await connection.execute(
        'INSERT INTO stocks (symbol, company_name) VALUES (?, ?)',
        [ticker.toUpperCase(), name]
      );

      // result.insertId is typically available for MySQL inserts
      const insertId = (result as any).insertId;

      return NextResponse.json(
        {
          status: 'success',
          message: 'Stock added successfully',
          stock_id: insertId,
        },
        { status: 201 }
      );
    } catch (dbError: any) {
      console.error('Database error:', dbError);
      return NextResponse.json(
        { status: 'error', message: 'Failed to add stock to database', details: dbError.message },
        { status: 500 }
      );
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  } catch (error: any) {
    console.error('Request parsing error:', error);
    return NextResponse.json(
      { status: 'error', message: 'Invalid request body', details: error.message },
      { status: 400 }
    );
  }
}
