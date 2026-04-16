import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/worldbank/macro');

/**
 * Returns latest macro indicators for the US (GDP, Inflation, Consumption).
 */
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  try {
    const [rows] = await executeRawQuery(`
      SELECT indicator_code, year, value
      FROM world_bank_macro_data
      WHERE country_code = 'USA'
        AND indicator_code IN ('NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'NE.CON.PRVT.KD.ZG')
      ORDER BY year DESC;
    `, []);

    const data = rows as any[];
    
    // Group by indicator and get latest value
    const latest: Record<string, number | null> = {
      gdpGrowth: null,
      inflation: null,
      consumptionGrowth: null,
    };

    const mapping: Record<string, string> = {
      'NY.GDP.MKTP.KD.ZG': 'gdpGrowth',
      'FP.CPI.TOTL.ZG': 'inflation',
      'NE.CON.PRVT.KD.ZG': 'consumptionGrowth',
    };

    data.forEach(row => {
      const key = mapping[row.indicator_code];
      if (key && latest[key] === null) {
        latest[key] = parseFloat(row.value);
      }
    });

    return NextResponse.json({ 
      success: true, 
      country: 'USA',
      indicators: latest,
      asOf: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error("Failed to fetch World Bank macro data.", error);
    return createErrorResponse(error, 'Failed to fetch macro data.', { status: 500 });
  }
}
