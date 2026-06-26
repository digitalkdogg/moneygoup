import { GET } from '@/app/api/stock_data/[ticker]/industry/route';
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { yahooFinance, getSectorStocks } from '@/utils/yahooFinanceHelper';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { getDbConnection } from '@/utils/db';

jest.mock('next/server', () => ({
  NextRequest: jest.fn(() => ({ url: 'http://localhost/api/stock_data/some_ticker/industry' })),
  NextResponse: {
    json: jest.fn((data, options) => ({
      json: () => Promise.resolve(data),
      status: options?.status || 200,
    })),
  },
}));

jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));
jest.mock('@/utils/originCheck', () => ({ checkOrigin: jest.fn() }));

jest.mock('@/utils/errorResponse', () => ({
  createErrorResponse: jest.fn((error, message) => ({
    message, error, status: 500,
    json: () => Promise.resolve({ message, error })
  })),
  unauthorizedResponse: jest.fn(() => ({ status: 401, json: () => Promise.resolve({ message: 'Unauthorized' }) })),
}));

jest.mock('@/utils/yahooFinanceHelper', () => ({
  yahooFinance: { search: jest.fn(), quoteSummary: jest.fn(), screener: jest.fn(), quote: jest.fn() },
  getSectorStocks: jest.fn(),
}));

jest.mock('@/utils/approvalStatus', () => ({
  checkApprovalGuard: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock('@/utils/db', () => ({
  getDbConnection: jest.fn(),
}));


function mockDbReturning(rows: any[]) {
  (getDbConnection as jest.Mock).mockResolvedValue({
    query: jest.fn().mockResolvedValue([rows, []]),
  });
}

function quoteFor(symbol: string, overrides: Partial<any> = {}) {
  return {
    symbol,
    longName: `${symbol} Inc`,
    regularMarketPrice: 200,
    regularMarketChange: 1.2,
    regularMarketChangePercent: 0.6,
    marketCap: 100_000_000_000,
    regularMarketVolume: 10_000_000,
    fiftyTwoWeekHigh: 250,
    fiftyTwoWeekLow: 150,
    ...overrides,
  };
}


describe('Industry Sector API', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (checkApprovalGuard as jest.Mock).mockResolvedValue({ allowed: true });

    (NextResponse.json as jest.Mock).mockImplementation((data, options) => ({
      json: () => Promise.resolve(data),
      status: options?.status || 200,
    }));

    (unauthorizedResponse as jest.Mock).mockReturnValue({
      status: 401, json: () => Promise.resolve({ message: 'Unauthorized' })
    });

    (createErrorResponse as jest.Mock).mockImplementation((error, message) => ({
      status: 500, json: () => Promise.resolve({ message, error: error?.message || String(error) })
    }));
  });

  it('returns unauthorized if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    (checkOrigin as jest.Mock).mockReturnValue(null);

    const response = await GET(
      new NextRequest('http://localhost/api/stock_data/Technology/industry'),
      { params: Promise.resolve({ ticker: 'Technology' }) },
    );

    expect(unauthorizedResponse).toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it('returns origin error if checkOrigin fails', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'a@b.c' } });
    (checkOrigin as jest.Mock).mockReturnValue({ status: 403, json: () => Promise.resolve({ message: 'Invalid Origin' }) });

    const response = await GET(
      new NextRequest('http://localhost/api/stock_data/Technology/industry'),
      { params: Promise.resolve({ ticker: 'Technology' }) },
    );

    expect(response.status).toBe(403);
  });

  it('returns empty for non-canonical input without calling Yahoo or DB', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'a@b.c' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    const response = await GET(
      new NextRequest('http://localhost/api/stock_data/cybersecurity/industry'),
      { params: Promise.resolve({ ticker: 'cybersecurity' }) },
    );

    expect(getSectorStocks).not.toHaveBeenCalled();
    expect(yahooFinance.quote).not.toHaveBeenCalled();
    expect(getDbConnection).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body.input).toBe('cybersecurity');
    expect(body.stocks).toHaveLength(0);
    expect(body.message).toContain('cybersecurity');
  });

  it('returns GPS-sorted stocks for a canonical sector, joining stock_gps_scores by symbol', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'a@b.c' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (getSectorStocks as jest.Mock).mockResolvedValueOnce([
      { symbol: 'NVDA' }, { symbol: 'AAPL' }, { symbol: 'MSFT' },
    ]);
    (yahooFinance.quote as jest.Mock).mockResolvedValueOnce([
      quoteFor('NVDA', { regularMarketPrice: 180 }),
      quoteFor('AAPL', { regularMarketPrice: 240 }),
      quoteFor('MSFT', { regularMarketPrice: 270 }),
    ]);

    // GPS DB returns: NVDA highest, AAPL middle, MSFT no row (placeholder)
    mockDbReturning([
      { symbol: 'NVDA', gps_score: '82.5', gps_breakdown: '{"mlpUpside":15}', as_of: '2026-06-21T10:00:00Z' },
      { symbol: 'AAPL', gps_score: '67.0', gps_breakdown: '{"mlpUpside":10}', as_of: '2026-06-21T10:00:00Z' },
    ]);

    const response = await GET(
      new NextRequest('http://localhost/api/stock_data/Technology/industry'),
      { params: Promise.resolve({ ticker: 'Technology' }) },
    );

    expect(response.status).toBe(200);
    expect(getSectorStocks).toHaveBeenCalledWith('Technology', 50);

    const body = await response.json();
    expect(body.input).toBe('Technology');
    expect(body.industry).toBe('Technology');
    // horizonLabel reflects the user's investment_timeframe via getUserStrategy.
    // This test's session mock has no user.id, so the route falls back to
    // DEFAULT_STRATEGY (1_month → '1M' shortLabel).
    expect(body.horizonLabel).toBe('1M');
    expect(body.stocks).toHaveLength(3);
    // Sorted by GPS desc; null-GPS rows last
    expect(body.stocks.map((s: any) => s.symbol)).toEqual(['NVDA', 'AAPL', 'MSFT']);
    expect(body.stocks[0].gps_score).toBe(82.5);
    expect(body.stocks[0].gps_breakdown).toEqual({ mlpUpside: 15 });
    expect(body.stocks[2].gps_score).toBeNull();
    expect(body.stocks[2].gps_breakdown).toBeNull();
  });

  it('decodes URL-encoded multi-word sectors before dispatch', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'a@b.c' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (getSectorStocks as jest.Mock).mockResolvedValueOnce([{ symbol: 'JPM' }, { symbol: 'V' }]);
    (yahooFinance.quote as jest.Mock).mockResolvedValueOnce([
      quoteFor('JPM', { regularMarketPrice: 200 }),
      quoteFor('V', { regularMarketPrice: 280 }),
    ]);
    mockDbReturning([
      { symbol: 'JPM', gps_score: '70.0', gps_breakdown: null, as_of: null },
      { symbol: 'V', gps_score: '65.0', gps_breakdown: null, as_of: null },
    ]);

    const response = await GET(
      new NextRequest('http://localhost/api/stock_data/Financial%20Services/industry'),
      { params: Promise.resolve({ ticker: 'Financial%20Services' }) },
    );

    expect(response.status).toBe(200);
    expect(getSectorStocks).toHaveBeenCalledWith('Financial Services', 50);

    const body = await response.json();
    expect(body.input).toBe('Financial Services');
    expect(body.industry).toBe('Financial Services');
    expect(body.stocks.map((s: any) => s.symbol)).toEqual(['JPM', 'V']);
  });

  it('drops stocks above the $300 price ceiling', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'a@b.c' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (getSectorStocks as jest.Mock).mockResolvedValueOnce([{ symbol: 'BRK-A' }, { symbol: 'NVDA' }]);
    (yahooFinance.quote as jest.Mock).mockResolvedValueOnce([
      quoteFor('BRK-A', { regularMarketPrice: 700_000 }),  // above ceiling
      quoteFor('NVDA',  { regularMarketPrice: 180 }),
    ]);
    mockDbReturning([
      { symbol: 'NVDA', gps_score: '82.5', gps_breakdown: null, as_of: null },
    ]);

    const response = await GET(
      new NextRequest('http://localhost/api/stock_data/Technology/industry'),
      { params: Promise.resolve({ ticker: 'Technology' }) },
    );

    const body = await response.json();
    expect(body.stocks).toHaveLength(1);
    expect(body.stocks[0].symbol).toBe('NVDA');
  });

  it('handles errors gracefully', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'a@b.c' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getSectorStocks as jest.Mock).mockRejectedValueOnce(new Error('Yahoo sector screener failed'));

    const response = await GET(
      new NextRequest('http://localhost/api/stock_data/Technology/industry'),
      { params: Promise.resolve({ ticker: 'Technology' }) },
    );

    expect(response.status).toBe(500);
    expect(createErrorResponse).toHaveBeenCalled();
  });
});
