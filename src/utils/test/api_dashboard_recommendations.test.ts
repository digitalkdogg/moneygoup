import { NextRequest } from 'next/server';
import { GET } from '@/app/api/dashboard/recommendations/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooQuotesForSymbols } from '@/utils/yahooFinanceHelper';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/utils/yahooFinanceHelper');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock('@/utils/approvalStatus', () => ({
  checkApprovalGuard: jest.fn().mockResolvedValue({ allowed: true }),
}));

describe('GET /api/dashboard/recommendations', () => {
  let mockRequest: any;

  // Pin GPS_PREDICTION_MAX + all dashboard threshold env vars to the code
  // defaults. The test fixtures assume default behavior; .env.local
  // (production tuning) overrides them and leaks into the Jest process via
  // Next.js route module imports.
  const _pinnedKeys = [
    'GPS_PREDICTION_MAX',
    'GPS_BASELINE',
    'GPS_SELL_OFFSET',
    'GPS_DISCOVERY_OFFSET',
  ];
  const _saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of _pinnedKeys) {
      _saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GPS_PREDICTION_MAX = '3';
  });
  afterAll(() => {
    for (const k of _pinnedKeys) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: '123' } });
    // fetchMacroContext makes a real HTTP call to /api/worldbank; stub it out
    // so tests don't depend on the dev server being up or the World Bank API
    // being fast. Returning { ok: false } makes fetchMacroContext return null,
    // keeping macroGpsAdjustment at 0.
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false } as Response);

    mockRequest = {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/dashboard/recommendations'),
    } as unknown as NextRequest;
  });

  test('returns BUY recommendation when predicted price is >= 3% higher', async () => {
    // 0. Mock user strategy (neutral baseline)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]]);
    // 1. Mock predictions (current 100, predicted 103 -> +3%, gps_score 70 >= buy threshold 65)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [
        { stock_id: 1, symbol: 'AAPL', predicted_price_1m: '103', gps_score: '70', gps_breakdown: null, last_requested_at: '2026-04-11T12:00:00Z', is_purchased: 1, user_confirmed: 1, shares: 10, is_active: 1 }
      ]
    ]);
    // 1b. Mock ETF holdings recommendations query (none)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]);

    // 2. Mock Yahoo Finance utility (current price 100)
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 1, symbol: 'AAPL', price: 100, companyName: 'Apple' }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].symbol).toBe('AAPL');
    expect(data.recommendations[0].action).toBe('BUY');
    expect(data.recommendations[0].deltaPct).toBe(3);
    expect(data.recommendations[0].scope).toBe('portfolio');
  });

  test('returns SELL recommendation when predicted price is <= 3% lower', async () => {
    // 0. Mock user strategy (neutral baseline)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]]);
    // 1. Mock predictions (current 100, predicted 97 -> -3%, gps_score 30 < sell threshold 45)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [
        { stock_id: 2, symbol: 'TSLA', predicted_price_1m: '97', gps_score: '30', gps_breakdown: null, last_requested_at: '2026-04-11T12:00:00Z', is_purchased: 1, user_confirmed: 1, shares: 5, is_active: 1 }
      ]
    ]);
    // 1b. Mock ETF holdings recommendations query (none)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]);

    // 2. Mock Yahoo Finance utility (current price 100)
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 2, symbol: 'TSLA', price: 100, companyName: 'Tesla' }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].symbol).toBe('TSLA');
    expect(data.recommendations[0].action).toBe('SELL');
    expect(data.recommendations[0].deltaPct).toBe(-3);
    expect(data.recommendations[0].scope).toBe('portfolio');
  });

  test('returns discovery recommendation when user_confirmed is 0', async () => {
    // 0. Mock user strategy (neutral baseline)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]]);
    // 1. Mock predictions (current 100, predicted 110 -> +10%, gps_score 75 >= discovery threshold 70)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [
        { stock_id: 4, symbol: 'NVDA', predicted_price_1m: '110', gps_score: '75', gps_breakdown: null, last_requested_at: '2026-04-11T12:00:00Z', is_purchased: 0, user_confirmed: 0, shares: 0, is_active: 1 }
      ]
    ]);
    // 1b. Mock ETF holdings recommendations query (none)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]);

    // 2. Mock Yahoo Finance utility (current price 100)
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 4, symbol: 'NVDA', price: 100, companyName: 'NVIDIA' }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].symbol).toBe('NVDA');
    expect(data.recommendations[0].scope).toBe('discovery');
    expect(data.recommendations[0].action).toBe('BUY');
  });

  test('returns no recommendation when GPS score is in hold band (45–65)', async () => {
    // 0. Mock user strategy (neutral baseline)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]]);
    // 1. Mock predictions (gps_score 55 — between sell threshold 45 and buy threshold 65)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([
      [
        { stock_id: 3, symbol: 'MSFT', predicted_price_1m: '102', gps_score: '55', gps_breakdown: null, last_requested_at: '2026-04-11T12:00:00Z', is_purchased: 1, user_confirmed: 1, shares: 1, is_active: 1 }
      ]
    ]);
    // 1b. Mock ETF holdings recommendations query (none)
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]);

    // 2. Mock Yahoo Finance utility (current price 100)
    (fetchYahooQuotesForSymbols as jest.Mock).mockResolvedValue([
      { stock_id: 3, symbol: 'MSFT', price: 100, companyName: 'Microsoft' }
    ]);

    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.recommendations).toHaveLength(0);
  });

  test('returns 401 if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });
});
