import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/worldbank');

/**
 * Consolidated World Bank Data Endpoint
 * Returns Macro indicators, ETF factors, and Global Risk Index in a single response.
 */
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  try {
    // 1. Fetch all required data in parallel
    const [macroRowsResult, etfRowsResult, riskRowsResult] = await Promise.all([
      // US Macro Data
      executeRawQuery(`
        SELECT indicator_code, year, value
        FROM world_bank_macro_data
        WHERE country_code = 'USA'
          AND indicator_code IN ('NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'NE.CON.PRVT.KD.ZG')
        ORDER BY year DESC;
      `, []),
      // ETF GPS Factors
      executeRawQuery(`
        SELECT theme_or_sector, indicator_code, latest_value, multiplier_effect
        FROM world_bank_etf_gps_factors
        ORDER BY theme_or_sector;
      `, []),
      // Multi-country Risk Data
      executeRawQuery(`
        SELECT country_code, indicator_code, year, value
        FROM world_bank_macro_data
        WHERE country_code IN ('USA', 'GBR', 'CHN', 'IND', 'DEU')
          AND indicator_code IN ('NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS')
        ORDER BY year DESC;
      `, [])
    ]);

    const macroRows = macroRowsResult[0] as any[];
    const etfRows = etfRowsResult[0] as any[];
    const riskRows = riskRowsResult[0] as any[];

    // ── SECTION 1: MACD INDICATORS (US) ──
    const macroLatest: Record<string, number | null> = {
      gdpGrowth: null,
      inflation: null,
      consumptionGrowth: null,
    };
    const macroMapping: Record<string, string> = {
      'NY.GDP.MKTP.KD.ZG': 'gdpGrowth',
      'FP.CPI.TOTL.ZG': 'inflation',
      'NE.CON.PRVT.KD.ZG': 'consumptionGrowth',
    };
    macroRows.forEach(row => {
      const key = macroMapping[row.indicator_code];
      if (key && macroLatest[key] === null) {
        macroLatest[key] = parseFloat(row.value);
      }
    });

    // ── SECTION 2: ETF FACTORS ──
    const etfFactors: Record<string, any[]> = {};
    etfRows.forEach(row => {
      const theme = row.theme_or_sector;
      if (!etfFactors[theme]) etfFactors[theme] = [];
      etfFactors[theme].push({
        indicator: row.indicator_code,
        value: parseFloat(row.latest_value),
        multiplier: parseFloat(row.multiplier_effect)
      });
    });

    // ── SECTION 3: RISK INDEX (MULTI-COUNTRY) ──
    const riskCountries: Record<string, Record<string, number | null>> = {
      'USA': { gdp: null, inflation: null, unemployment: null },
      'GBR': { gdp: null, inflation: null, unemployment: null },
      'CHN': { gdp: null, inflation: null, unemployment: null },
      'IND': { gdp: null, inflation: null, unemployment: null },
      'DEU': { gdp: null, inflation: null, unemployment: null },
    };
    const riskMapping: Record<string, string> = {
      'NY.GDP.MKTP.KD.ZG': 'gdp',
      'FP.CPI.TOTL.ZG': 'inflation',
      'SL.UEM.TOTL.ZS': 'unemployment',
    };
    riskRows.forEach(row => {
      const countryData = riskCountries[row.country_code];
      const key = riskMapping[row.indicator_code];
      if (countryData && key && countryData[key] === null) {
        countryData[key] = parseFloat(row.value);
      }
    });

    // Calculate global macro health score (0-100)
    let totalScore = 0;
    let scoredCountries = 0;
    Object.entries(riskCountries).forEach(([code, vals]) => {
      if (vals.gdp !== null && vals.inflation !== null && vals.unemployment !== null) {
        const gdpScore = Math.max(0, Math.min(100, (vals.gdp + 2) * 10));
        const infScore = Math.max(0, Math.min(100, 100 - (vals.inflation * 10)));
        const uemScore = Math.max(0, Math.min(100, 100 - (vals.unemployment * 5)));
        totalScore += (gdpScore + infScore + uemScore) / 3;
        scoredCountries++;
      }
    });
    const globalHealthScore = scoredCountries > 0 ? parseFloat((totalScore / scoredCountries).toFixed(1)) : null;

    // ── RETURN CONSOLIDATED PAYLOAD ──
    return NextResponse.json({
      success: true,
      macro: {
        country: 'USA',
        indicators: macroLatest
      },
      etf_factors: {
        themes: etfFactors
      },
      risk_index: {
        countries: riskCountries,
        globalHealthScore
      },
      asOf: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error("Failed to fetch consolidated World Bank data.", error);
    return createErrorResponse(error, 'Failed to fetch consolidated macro data.', { status: 500 });
  }
}
