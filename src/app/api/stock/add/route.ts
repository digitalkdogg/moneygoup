import { NextRequest, NextResponse } from 'next/server';
import { getDbConnection } from '@/utils/db';
import { validate } from '@/utils/validation';
import { addStockSchema, AddStockInput } from './schema';

export const POST = validate(addStockSchema)(
  async (request: NextRequest, response: NextResponse, data: AddStockInput) => {
    const { ticker, name } = data;

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
        { status: 'error', message: 'Failed to add stock to database' },
        { status: 500 }
      );
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  }
);
