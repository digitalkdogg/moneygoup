import { NextRequest } from 'next/server';
import { GET } from '@/app/api/user/portfolio/compare-series/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { checkOrigin } from '@/utils/originCheck';

jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
jest.mock('@/lib/auth', () => ({ authOptions: {} }));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/utils/yahooFinanceHelper', () => ({
  yahooFinance: { historical: jest.fn() },
}));

const SESSION = { user: { id: 42 } };

const HOLDING = { shares: '10.5', initial_purchase_date: '2024-01-15' };

const QUOTES = [
  { date: new Date('2024-06-01'), close: 180.00, adjClose: 179.50 },
  { date: new Date('2024-06-02'), close: 182.00, adjClose: 181.40 },
  { date: new Date('2024-06-03'), close: null,   adjClose: null   }, // should be filtered
  { date: new Date('2024-06-04'), close: 185.00, adjClose: 184.30 },
];

const createRequest = (params: Record<string, string>) => {
  const url = new URL('http://localhost/api/user/portfolio/compare-series');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
};

describe('GET /api/user/portfolio/compare-series', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue(SESSION);
    (executeRawQuery as jest.Mock).mockResolvedValue([[HOLDING]]);
    (yahooFinance.historical as jest.Mock).mockResolvedValue(QUOTES);
  });

  // ── Guards ──────────────────────────────────────────────────────────────────

  test('returns 403 when origin check fails', async () => {
    (checkOrigin as jest.Mock).mockReturnValue({ status: 403 });

    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));

    expect(res.status).toBe(403);
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('returns 401 when unauthenticated', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);

    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  test('returns 400 when ticker param is missing', async () => {
    const res = await GET(createRequest({ period: '1m' }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe('Invalid ticker');
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  test('returns 404 when holding is not in the user portfolio', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValue([[]]); // no rows

    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toBe('Holding not found');
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  test('returns {date, value}[] with value = shares × adjClose', async () => {
    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    // 3 valid quotes (null close filtered out)
    expect(data).toHaveLength(3);
    expect(data[0]).toEqual({
      date: '2024-06-01',
      value: 10.5 * 179.50,
    });
    expect(data[1]).toEqual({
      date: '2024-06-02',
      value: 10.5 * 181.40,
    });
    expect(data[2]).toEqual({
      date: '2024-06-04',
      value: 10.5 * 184.30,
    });
  });

  test('falls back to close price when adjClose is absent', async () => {
    const quotesNoAdj = [
      { date: new Date('2024-06-01'), close: 180.00 }, // no adjClose field
    ];
    (yahooFinance.historical as jest.Mock).mockResolvedValue(quotesNoAdj);

    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].value).toBeCloseTo(10.5 * 180.00);
  });

  test('filters out quotes with null close', async () => {
    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));
    const data = await res.json();

    const dates = data.map((d: any) => d.date);
    expect(dates).not.toContain('2024-06-03');
  });

  test('uppercases the ticker before DB lookup', async () => {
    await GET(createRequest({ ticker: 'aapl', period: '1m' }));

    const [[, params]] = (executeRawQuery as jest.Mock).mock.calls;
    expect(params[1]).toBe('AAPL');
  });

  test('defaults to period 1m when period param is omitted', async () => {
    const before = Date.now();
    await GET(createRequest({ ticker: 'AAPL' }));
    const after = Date.now();

    const { period1 } = (yahooFinance.historical as jest.Mock).mock.calls[0][1];
    // period1 should be ~1 month ago
    const oneMonthAgo = new Date(before);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    expect(new Date(period1).getTime()).toBeGreaterThanOrEqual(oneMonthAgo.getTime() - 5000);
    expect(new Date(period1).getTime()).toBeLessThanOrEqual(after);
  });

  test('passes the correct user_id and ticker to the DB query', async () => {
    await GET(createRequest({ ticker: 'TSLA', period: '1m' }));

    const [[, params]] = (executeRawQuery as jest.Mock).mock.calls;
    expect(params[0]).toBe(SESSION.user.id);
    expect(params[1]).toBe('TSLA');
  });

  // ── Yahoo Finance failure ───────────────────────────────────────────────────

  test('returns empty array when Yahoo Finance throws', async () => {
    (yahooFinance.historical as jest.Mock).mockRejectedValue(new Error('rate limited'));

    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual([]);
  });

  test('returns empty array when Yahoo Finance returns no quotes', async () => {
    (yahooFinance.historical as jest.Mock).mockResolvedValue([]);

    const res = await GET(createRequest({ ticker: 'AAPL', period: '1m' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual([]);
  });

  // ── Period / start-date clamping ────────────────────────────────────────────

  test('clamps start date to purchase date when purchase date is more recent', async () => {
    // Purchase date 3 days ago — more recent than the 1m window start
    const recentPurchase = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    (executeRawQuery as jest.Mock).mockResolvedValue([[
      { shares: '5', initial_purchase_date: recentPurchase },
    ]]);

    await GET(createRequest({ ticker: 'AAPL', period: '1m' }));

    const [, { period1 }] = (yahooFinance.historical as jest.Mock).mock.calls[0];
    // period1 should be close to the purchase date, not 1 month ago
    const diff = Math.abs(new Date(period1).getTime() - new Date(recentPurchase).getTime());
    expect(diff).toBeLessThan(2000);
  });

  test('uses purchase date as start for period=all', async () => {
    const purchaseDate = '2022-03-10';
    (executeRawQuery as jest.Mock).mockResolvedValue([[
      { shares: '8', initial_purchase_date: purchaseDate },
    ]]);

    await GET(createRequest({ ticker: 'AAPL', period: 'all' }));

    const [, { period1 }] = (yahooFinance.historical as jest.Mock).mock.calls[0];
    expect(new Date(period1).toISOString().slice(0, 10)).toBe(purchaseDate);
  });

  test('uses 5-year fallback for period=all when no purchase date', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValue([[
      { shares: '8', initial_purchase_date: null },
    ]]);

    const before = Date.now();
    await GET(createRequest({ ticker: 'AAPL', period: 'all' }));

    const [, { period1 }] = (yahooFinance.historical as jest.Mock).mock.calls[0];
    const fiveYearsAgo = new Date(before);
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    expect(new Date(period1).getFullYear()).toBe(fiveYearsAgo.getFullYear());
  });
});
