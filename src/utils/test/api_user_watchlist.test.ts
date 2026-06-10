import { NextRequest } from 'next/server';
import { GET, DELETE } from '@/app/api/user/watchlist/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery, insert, upsert } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
 
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
 
// Mock yahoo-finance2 dynamic import.
// mockQuote must be declared inside the factory to avoid the "cannot access
// before initialization" hoisting error — jest.mock() is hoisted above const
// declarations, so any variable referenced in the factory must either live
// inside it or be a plain `var` (which is also hoisted).
let mockQuote: jest.Mock;
jest.mock(
  'yahoo-finance2',
  () => {
    const quoteFn = jest.fn();
    return {
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({ quote: quoteFn })),
      // Expose the inner fn so tests can reconfigure it after the fact
      __mockQuote: quoteFn,
    };
  },
  { virtual: true }
);
 
// ─── Shared helpers ────────────────────────────────────────────────────────────
 
const makeRequest = (url: string): NextRequest =>
  ({
    headers: new Headers(),
    url,
  } as unknown as NextRequest);
 
const mockSession = { user: { id: 123 } };
 
// ─── GET ───────────────────────────────────────────────────────────────────────
 
describe('GET /api/user/watchlist', () => {
  let mockRequest: any;
 
  beforeEach(async () => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue(mockSession);
    mockRequest = makeRequest('http://localhost/api/user/watchlist');
 
    // Grab the stable mock fn created inside the factory (avoids hoisting error)
    const yahoo = await import('yahoo-finance2');
    mockQuote = (yahoo as any).__mockQuote;
  });
 
  test('returns watchlist with live Yahoo data and MA', async () => {
    // 0: user strategy lookup. 1: watchlist items. 2+: daily prices per stock.
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[{ aggressiveness: 'neutral', investment_timeframe: '1_month' }]])
      .mockResolvedValueOnce([
        [{ stock_id: 1, symbol: 'AAPL', company_name: 'Apple Inc.', shares: 1, purchase_price: 0, is_purchased: 0, user_confirmed: 1, is_active: 1, db_price: 170, predicted_price_1m: 180 }],
      ])
      .mockResolvedValueOnce([
        [{ close: '168' }, { close: '170' }, { close: '172' }],
      ]);
 
    mockQuote.mockResolvedValue({ regularMarketPrice: 175, regularMarketPreviousClose: 169 });
    (fetchYahooStockSummary as jest.Mock).mockResolvedValue({
      financialData: { recommendationKey: 'buy', numberOfAnalystOpinions: 32 },
    });
 
    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
 
    expect(data.watchlist).toHaveLength(1);
    expect(data.watchlist[0]).toMatchObject({
      symbol: 'AAPL',
      regularMarketPrice: 175,
      prev_close: 169,
      recommendationKey: 'buy',
      numberOfAnalystOpinions: 32,
      ma6_month: (168 + 170 + 172) / 3,
    });

    // Verify the SQL contains the new filters
    expect(executeRawQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND us.user_confirmed = 1'),
      expect.any(Array)
    );
  });
 
  test('falls back to db_price when Yahoo quote fails', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[{ aggressiveness: 'neutral', investment_timeframe: '1_month' }]])
      .mockResolvedValueOnce([
        [{ stock_id: 2, symbol: 'MSFT', company_name: 'Microsoft', shares: 0, purchase_price: 0, is_purchased: 0, db_price: 300, predicted_price_1m: null }],
      ])
      .mockResolvedValueOnce([[{ close: '298' }, { close: '302' }]]);
 
    mockQuote.mockRejectedValue(new Error('Yahoo unavailable'));
    (fetchYahooStockSummary as jest.Mock).mockResolvedValue(null);
 
    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
 
    expect(data.watchlist[0]).toMatchObject({
      symbol: 'MSFT',
      regularMarketPrice: 300,
      prev_close: null,
      recommendationKey: null,
      numberOfAnalystOpinions: null,
    });
  });
 
  test('returns null for MA when no daily price data exists', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[{ aggressiveness: 'neutral', investment_timeframe: '1_month' }]])
      .mockResolvedValueOnce([
        [{ stock_id: 3, symbol: 'TSLA', company_name: 'Tesla', shares: 0, purchase_price: 0, is_purchased: 0, db_price: 250, predicted_price_1m: null }],
      ])
      .mockResolvedValueOnce([[]]); // empty price history
 
    mockQuote.mockResolvedValue({ regularMarketPrice: 255, regularMarketPreviousClose: 248 });
    (fetchYahooStockSummary as jest.Mock).mockResolvedValue(null);
 
    const response = await GET(mockRequest);
    const data = await response.json();
 
    expect(data.watchlist[0].ma6_month).toBeNull();
  });
 
  test('returns empty watchlist when user has no watchlist items', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[{ aggressiveness: 'neutral', investment_timeframe: '1_month' }]])
      .mockResolvedValueOnce([[]]);
 
    const response = await GET(mockRequest);
    expect(response.status).toBe(200);
    const data = await response.json();
 
    expect(data.watchlist).toEqual([]);
  });
 
  test('returns 401 if session is missing', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
 
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });
 
  test('returns 401 if session has no user id', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: {} });
 
    const response = await GET(mockRequest);
    expect(response.status).toBe(401);
  });
 
  test('returns 500 on database error', async () => {
    (executeRawQuery as jest.Mock).mockRejectedValue(new Error('DB connection lost'));
 
    const response = await GET(mockRequest);
    expect(response.status).toBe(500);
  });
 
  test('blocks request when origin check fails', async () => {
    const originBlock = new Response('Forbidden', { status: 403 });
    (checkOrigin as jest.Mock).mockReturnValue(originBlock);
 
    const response = await GET(mockRequest);
    expect(response.status).toBe(403);
  });
});
 
// ─── DELETE ────────────────────────────────────────────────────────────────────
 
describe('DELETE /api/user/watchlist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    (getServerSession as jest.Mock).mockResolvedValue(mockSession);
  });
 
  test('successfully removes a stock from the watchlist', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[{ id: 10 }]])  // stock lookup
      .mockResolvedValueOnce([{}]);            // delete
 
    const request = makeRequest('http://localhost/api/user/watchlist?stockId=AAPL');
    const response = await DELETE(request);
 
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ status: 'success', message: 'Stock removed from watchlist' });
 
    // Confirm the DELETE query ran with the right stock id
    expect(executeRawQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM user_stocks'),
      [mockSession.user.id, 10]
    );
  });
 
  test('returns 404 if the ticker does not exist in stocks table', async () => {
    (executeRawQuery as jest.Mock).mockResolvedValueOnce([[]]); // no stock found
 
    const request = makeRequest('http://localhost/api/user/watchlist?stockId=FAKE');
    const response = await DELETE(request);
 
    expect(response.status).toBe(404);
  });
 
  test('returns 400 if stockId query param is missing', async () => {
    const request = makeRequest('http://localhost/api/user/watchlist');
    const response = await DELETE(request);
 
    expect(response.status).toBe(400);
  });
 
  test('returns 401 if session is missing', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
 
    const request = makeRequest('http://localhost/api/user/watchlist?stockId=AAPL');
    const response = await DELETE(request);
 
    expect(response.status).toBe(401);
  });
 
  test('returns 500 on database error during delete', async () => {
    (executeRawQuery as jest.Mock)
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockRejectedValueOnce(new Error('DB error'));
 
    const request = makeRequest('http://localhost/api/user/watchlist?stockId=AAPL');
    const response = await DELETE(request);
 
    expect(response.status).toBe(500);
  });
 
  test('blocks request when origin check fails', async () => {
    const originBlock = new Response('Forbidden', { status: 403 });
    (checkOrigin as jest.Mock).mockReturnValue(originBlock);
 
    const request = makeRequest('http://localhost/api/user/watchlist?stockId=AAPL');
    const response = await DELETE(request);
 
    expect(response.status).toBe(403);
  });
});