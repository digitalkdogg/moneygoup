import { NextRequest, NextResponse } from 'next/server';
import { validate } from '@/utils/validation';
import { addStockSchema, AddStockInput } from './schema';
import { insert } from '@/utils/databaseHelper';

export const POST = validate(addStockSchema)(
  async (request: NextRequest, response: NextResponse, data: AddStockInput) => {
    const { ticker, name } = data;

    try {
      const insertId = await insert('stocks', {
        symbol: ticker.toUpperCase(),
        company_name: name,
      });

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
    }
  }
);
