import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { worldBankCache } from '@/utils/cache';

const logger = createLogger('api/worldbank');

/**
 * Consolidated World Bank Data Endpoint
 * Returns Macro indicators, ETF factors, and Global Risk Index in a single response.
 * Cached for 6 hours.
 */
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
  const isInternal = internalSecret && apiKey === internalSecret;

  if (!isInternal) {
    const session = await getServerSession(authOptions);
    if (!session?.user) return unauthorizedResponse();
  }

  // Check cache
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  if (!forceRefresh) {
    const cachedData = worldBankCache.get('consolidated_data');
    if (cachedData) {
      return NextResponse.json(cachedData);
    }
  } else {
    logger.info('World Bank cache bypass requested via ?refresh=true');
  }

  try {
    // 1. Fetch all required data in parallel
    const [macroRowsResult, etfRowsResult, riskRowsResult, trendRowsResult] = await Promise.all([
      // US Macro Data
      executeRawQuery(`
        SELECT indicator_code, year, value
        FROM world_bank_macro_data
        WHERE country_code = 'USA'
          AND indicator_code IN ('NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'NE.CON.PRVT.KD.ZG', 'SL.UEM.TOTL.ZS', 'BX.KLT.DINV.WD.GD.ZS', 'TG.VAL.TOTL.GD.ZS', 'IT.NET.USER.ZS', 'IT.CEL.SETS.P2', 'TX.VAL.ICTG.ZS.UN')
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
      `, []),
      // Trend Data (Last 2 years for deltas)
      executeRawQuery(`
        SELECT country_code, indicator_code, year, value
        FROM world_bank_macro_data
        WHERE country_code = 'USA'
          AND indicator_code IN ('NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS', 'BX.KLT.DINV.WD.GD.ZS', 'TG.VAL.TOTL.GD.ZS', 'IT.NET.USER.ZS', 'IT.CEL.SETS.P2', 'TX.VAL.ICTG.ZS.UN')
        ORDER BY indicator_code, year DESC;
      `, [])
    ]);

    const macroRows = macroRowsResult[0] as any[];
    const etfRows = etfRowsResult[0] as any[];
    const riskRows = riskRowsResult[0] as any[];
    const trendRows = trendRowsResult[0] as any[];

    // ── SECTION 1: MACRO INDICATORS (US) with Trend ──
    const macroLatest: Record<string, any> = {
      gdpGrowth: { latest: null, prior: null, delta: null, signal: 'neutral' },
      inflation: { latest: null, prior: null, delta: null, signal: 'neutral' },
      consumptionGrowth: { latest: null, prior: null, delta: null, signal: 'neutral' },
      unemployment: { latest: null, prior: null, delta: null, signal: 'neutral' },
      fdiInflows: { latest: null, prior: null, delta: null, signal: 'neutral' },
      tradeVolume: { latest: null, prior: null, delta: null, signal: 'neutral' },
      internetPenetration: { latest: null, prior: null, delta: null, signal: 'neutral' },
      mobileSubscriptions: { latest: null, prior: null, delta: null, signal: 'neutral' },
      ictExports: { latest: null, prior: null, delta: null, signal: 'neutral' },
    };

    const macroMapping: Record<string, string> = {
      'NY.GDP.MKTP.KD.ZG': 'gdpGrowth',
      'FP.CPI.TOTL.ZG': 'inflation',
      'NE.CON.PRVT.KD.ZG': 'consumptionGrowth',
      'SL.UEM.TOTL.ZS': 'unemployment',
      'BX.KLT.DINV.WD.GD.ZS': 'fdiInflows',
      'TG.VAL.TOTL.GD.ZS': 'tradeVolume',
      'IT.NET.USER.ZS': 'internetPenetration',
      'IT.CEL.SETS.P2': 'mobileSubscriptions',
      'TX.VAL.ICTG.ZS.UN': 'ictExports',
    };

    // Process trends
    const indicatorGroups: Record<string, any[]> = {};
    trendRows.forEach(row => {
      if (!indicatorGroups[row.indicator_code]) indicatorGroups[row.indicator_code] = [];
      indicatorGroups[row.indicator_code].push(row);
    });

    Object.entries(macroMapping).forEach(([code, key]) => {
      const group = indicatorGroups[code] || [];
      if (group.length >= 1) {
        macroLatest[key].latest = parseFloat(group[0].value);
        if (group.length >= 2) {
          macroLatest[key].prior = parseFloat(group[1].value);
          macroLatest[key].delta = macroLatest[key].latest - macroLatest[key].prior;
          
          // Basic signal logic
          if (key === 'unemployment' || key === 'inflation') {
            macroLatest[key].signal = macroLatest[key].delta > 0.2 ? 'bearish' : (macroLatest[key].delta < -0.2 ? 'bullish' : 'neutral');
          } else {
            macroLatest[key].signal = macroLatest[key].delta > 0.2 ? 'bullish' : (macroLatest[key].delta < -0.2 ? 'bearish' : 'neutral');
          }
        }
      }
    });

    // ── SECTION 2: ETF FACTORS & THEME TRENDS ──
    const etfFactors: Record<string, any[]> = {};
    const themeTrends: Record<string, any> = {};

    etfRows.forEach(row => {
      const theme = row.theme_or_sector;
      if (!etfFactors[theme]) etfFactors[theme] = [];
      etfFactors[theme].push({
        indicator: row.indicator_code,
        value: parseFloat(row.latest_value),
        multiplier: parseFloat(row.multiplier_effect)
      });

      // Add trend info to themes if available in macroLatest
      const macroKey = macroMapping[row.indicator_code];
      if (macroKey) {
        if (!themeTrends[theme]) themeTrends[theme] = {};
        themeTrends[theme][row.indicator_code] = macroLatest[macroKey];
      }
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
    const responseData = {
      success: true,
      macro: {
        country: 'USA',
        indicators: macroLatest
      },
      etf_factors: {
        themes: etfFactors,
        theme_trends: themeTrends
      },
      risk_index: {
        countries: riskCountries,
        globalHealthScore,
        asOfByCountry: Object.fromEntries(
            Object.keys(riskCountries).map(c => [c, new Date().toISOString().split('T')[0]]) // Placeholder for actual dates if needed
        )
      },
      asOf: new Date().toISOString()
    };

    // Store in cache
    worldBankCache.set('consolidated_data', responseData);

    return NextResponse.json(responseData);


  } catch (error: any) {
    logger.error("Failed to fetch consolidated World Bank data.", { error });
    return createErrorResponse(error, 'Failed to fetch consolidated macro data.', { status: 500 });
  }
}
