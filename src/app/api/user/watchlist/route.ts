import { NextRequest, NextResponse } from 'next/server';
import { validate } from '@/utils/validation';
import { addStockSchema, AddStockInput } from '@/app/api/user/watchlist/schema';
import { insert } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/user/watchlist');

export const POST = validate(addStockSchema)(
  async (request: NextRequest, data: AddStockInput) => {
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
      logger.error('Database error:', dbError);
      return createErrorResponse(dbError, 500);
    }
  }
);
