import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/worldbank/risk-index');

/**
 * Returns multi-country macro risk indicators and global macro health score.
 */
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  try {
    const [rows] = await executeRawQuery(`
      SELECT country_code, indicator_code, year, value
      FROM world_bank_macro_data
      WHERE country_code IN ('USA', 'GBR', 'CHN', 'IND', 'DEU')
        AND indicator_code IN ('NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS')
      ORDER BY year DESC;
    `, []);

    const data = rows as any[];
    
    // Group by country and indicator, getting the latest for each
    const countries: Record<string, Record<string, number | null>> = {
      'USA': { gdp: null, inflation: null, unemployment: null },
      'GBR': { gdp: null, inflation: null, unemployment: null },
      'CHN': { gdp: null, inflation: null, unemployment: null },
      'IND': { gdp: null, inflation: null, unemployment: null },
      'DEU': { gdp: null, inflation: null, unemployment: null },
    };

    const mapping: Record<string, string> = {
      'NY.GDP.MKTP.KD.ZG': 'gdp',
      'FP.CPI.TOTL.ZG': 'inflation',
      'SL.UEM.TOTL.ZS': 'unemployment',
    };

    data.forEach(row => {
      const countryData = countries[row.country_code];
      const key = mapping[row.indicator_code];
      if (countryData && key && countryData[key] === null) {
        countryData[key] = parseFloat(row.value);
      }
    });

    // Calculate lightweight global macro health score (0-100)
    // Higher GDP = better, Lower Inflation = better, Lower Unemployment = better
    let totalScore = 0;
    let scoredCountries = 0;

    Object.entries(countries).forEach(([code, vals]) => {
      if (vals.gdp !== null && vals.inflation !== null && vals.unemployment !== null) {
        // Simple heuristic normalization
        const gdpScore = Math.max(0, Math.min(100, (vals.gdp + 2) * 10)); // -2% to 8% range mapped to 0-100
        const infScore = Math.max(0, Math.min(100, 100 - (vals.inflation * 10))); // 0-10% inflation
        const uemScore = Math.max(0, Math.min(100, 100 - (vals.unemployment * 5))); // 0-20% unemployment
        
        const countryAvg = (gdpScore + infScore + uemScore) / 3;
        totalScore += countryAvg;
        scoredCountries++;
      }
    });

    const globalHealthScore = scoredCountries > 0 ? totalScore / scoredCountries : null;

    return NextResponse.json({ 
      success: true, 
      countries,
      globalHealthScore: globalHealthScore !== null ? parseFloat(globalHealthScore.toFixed(1)) : null,
      asOf: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error("Failed to fetch World Bank risk index.", error);
    return createErrorResponse(error, 'Failed to fetch risk index.', { status: 500 });
  }
}
