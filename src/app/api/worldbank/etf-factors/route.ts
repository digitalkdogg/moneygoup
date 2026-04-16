import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/worldbank/etf-factors');

/**
 * Returns latest ETF GPS factors (FDI, Trade Volume, Internet Penetration).
 */
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  try {
    const [rows] = await executeRawQuery(`
      SELECT theme_or_sector, indicator_code, latest_value, multiplier_effect
      FROM world_bank_etf_gps_factors
      ORDER BY theme_or_sector;
    `, []);

    const data = rows as any[];
    
    // Group by theme/sector
    const themes: Record<string, any[]> = {};

    data.forEach(row => {
      const theme = row.theme_or_sector;
      if (!themes[theme]) {
        themes[theme] = [];
      }
      themes[theme].push({
        indicator: row.indicator_code,
        value: parseFloat(row.latest_value),
        multiplier: parseFloat(row.multiplier_effect)
      });
    });

    return NextResponse.json({ 
      success: true, 
      themes,
      asOf: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error("Failed to fetch World Bank ETF factors.", error);
    return createErrorResponse(error, 'Failed to fetch ETF factors.', { status: 500 });
  }
}
