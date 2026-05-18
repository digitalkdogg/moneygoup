import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worldbank/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { worldBankCache } from '@/utils/cache';

// Mock dependencies
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth', () => ({ authOptions: {} }));
jest.mock('@/utils/originCheck');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('GET /api/worldbank', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
    worldBankCache.clear();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1 } });

    mockRequest = {
      headers: new Headers(),
      url: 'http://localhost/api/worldbank',
      nextUrl: new URL('http://localhost/api/worldbank'),
    } as unknown as NextRequest;
  });

  test('returns cached data if available', async () => {
    const cachedData = { success: true, fromCache: true };
    worldBankCache.set('consolidated_data', cachedData);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.fromCache).toBe(true);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('fetches from database and populates cache on cache miss', async () => {
    const mockMacroRows = [
      { indicator_code: 'NY.GDP.MKTP.KD.ZG', year: 2023, value: '2.5' },
      { indicator_code: 'FP.CPI.TOTL.ZG', year: 2023, value: '1.8' },
      { indicator_code: 'NE.CON.PRVT.KD.ZG', year: 2023, value: '2.1' },
    ];
    const mockEtfRows = [
      { theme_or_sector: 'AI', indicator_code: 'IT.NET.USER.ZS', latest_value: '85.0', multiplier_effect: '1.1' }
    ];
    const mockRiskRows = [
      { country_code: 'USA', indicator_code: 'NY.GDP.MKTP.KD.ZG', year: 2023, value: '2.5' },
      { country_code: 'USA', indicator_code: 'FP.CPI.TOTL.ZG', year: 2023, value: '1.8' },
      { country_code: 'USA', indicator_code: 'SL.UEM.TOTL.ZS', year: 2023, value: '3.9' }
    ];
    const mockTrendRows = [
      { country_code: 'USA', indicator_code: 'NY.GDP.MKTP.KD.ZG', year: 2023, value: '2.5' },
      { country_code: 'USA', indicator_code: 'NY.GDP.MKTP.KD.ZG', year: 2022, value: '2.3' },
    ];

    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([mockMacroRows])
      .mockResolvedValueOnce([mockEtfRows])
      .mockResolvedValueOnce([mockRiskRows])
      .mockResolvedValueOnce([mockTrendRows]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.macro.indicators.gdpGrowth.latest).toBe(2.5);
    expect(data.etf_factors.themes.AI).toHaveLength(1);
    expect(data.risk_index.countries.USA.gdp).toBe(2.5);
    expect(data.risk_index.globalHealthScore).toBeDefined();

    // Verify cache was populated
    expect(worldBankCache.has('consolidated_data')).toBe(true);
  });

  test('calculates globalHealthScore correctly', async () => {
    const mockMacroRows: any[] = [];
    const mockEtfRows: any[] = [];
    const mockRiskRows = [
      { country_code: 'USA', indicator_code: 'NY.GDP.MKTP.KD.ZG', year: 2023, value: '3.0' }, // gdpScore = (3+2)*10 = 50
      { country_code: 'USA', indicator_code: 'FP.CPI.TOTL.ZG', year: 2023, value: '2.0' },  // infScore = 100-(2*10) = 80
      { country_code: 'USA', indicator_code: 'SL.UEM.TOTL.ZS', year: 2023, value: '4.0' }   // uemScore = 100-(4*5) = 80
      // Country score = (50+80+80)/3 = 70
    ];
    const mockTrendRows: any[] = [];

    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([mockMacroRows])
      .mockResolvedValueOnce([mockEtfRows])
      .mockResolvedValueOnce([mockRiskRows])
      .mockResolvedValueOnce([mockTrendRows]);

    const response = await GET(mockRequest);
    const data = await response.json();
    expect(data.risk_index.globalHealthScore).toBe(70);
  });

  test('handles database errors gracefully', async () => {
    (executeRawQuery as jest.Mock).mockRejectedValue(new Error('DB Error'));

    const response = await GET(mockRequest);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.message).toContain('Failed to fetch consolidated macro data');
    expect(data.correlationId).toBeDefined();
  });

  test('handles checkOrigin failure', async () => {
    (checkOrigin as jest.Mock).mockReturnValue(new Response('Forbidden', { status: 403 }));

    const response = await GET(mockRequest);
    expect(response.status).toBe(403);
  });
});
