import { GET } from '@/app/api/stock_data/[ticker]/industry/route';
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { yahooFinance, getSectorStocks } from '@/utils/yahooFinanceHelper';
import { checkApprovalGuard } from '@/utils/approvalStatus';

jest.mock('next/server', () => ({
  NextRequest: jest.fn(() => ({ url: 'http://localhost/api/stock_data/some_ticker/industry' })),
  NextResponse: {
    json: jest.fn((data, options) => ({
      json: () => Promise.resolve(data),
      status: options?.status || 200,
    })),
  },
}));

jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/utils/originCheck', () => ({
  checkOrigin: jest.fn(),
}));

jest.mock('@/utils/errorResponse', () => ({
  createErrorResponse: jest.fn((error, message) => ({
    message,
    error,
    status: 500,
    json: () => Promise.resolve({ message, error })
  })),
  unauthorizedResponse: jest.fn(() => ({ status: 401, json: () => Promise.resolve({ message: 'Unauthorized' }) })),
}));

jest.mock('@/utils/yahooFinanceHelper', () => ({
  yahooFinance: {
    search: jest.fn(),
    quoteSummary: jest.fn(),
    screener: jest.fn(),
    quote: jest.fn(),
  },
  getSectorStocks: jest.fn(),
}));

jest.mock('@/utils/approvalStatus', () => ({
  checkApprovalGuard: jest.fn().mockResolvedValue({ allowed: true }),
}));


describe('Industry Sector API', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (checkApprovalGuard as jest.Mock).mockResolvedValue({ allowed: true });

    (NextResponse.json as jest.Mock).mockImplementation((data, options) => ({
      json: () => Promise.resolve(data),
      status: options?.status || 200,
    }));

    (unauthorizedResponse as jest.Mock).mockReturnValue({
      status: 401,
      json: () => Promise.resolve({ message: 'Unauthorized' })
    });

    (createErrorResponse as jest.Mock).mockImplementation((error, message) => ({
      status: 500,
      json: () => Promise.resolve({ message, error: error?.message || String(error) })
    }));
  });

  it('should return unauthorized if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    (checkOrigin as jest.Mock).mockReturnValue(null);

    const request = new NextRequest('http://localhost/api/stock_data/Technology/industry');
    const response = await GET(request, { params: Promise.resolve({ ticker: 'Technology' }) });

    expect(getServerSession).toHaveBeenCalled();
    expect(unauthorizedResponse).toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it('should return an origin error if checkOrigin fails', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue({
      status: 403,
      json: () => Promise.resolve({ message: 'Invalid Origin' })
    });

    const request = new NextRequest('http://localhost/api/stock_data/Technology/industry');
    const response = await GET(request, { params: Promise.resolve({ ticker: 'Technology' }) });

    expect(checkOrigin).toHaveBeenCalledWith(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ message: 'Invalid Origin' });
  });

  it('should return scored stocks for a canonical sector', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (getSectorStocks as jest.Mock).mockResolvedValueOnce([
      { symbol: 'MSFT' },
      { symbol: 'GOOG' },
    ]);

    (yahooFinance.quote as jest.Mock).mockResolvedValueOnce([
      {
        symbol: 'MSFT',
        longName: 'Microsoft Corp',
        regularMarketPrice: 250,
        regularMarketChange: 2.5,
        regularMarketChangePercent: 1.0,
        marketCap: 2000000000000,
        regularMarketVolume: 50000000,
        averageDailyVolume3Month: 40000000,
        fiftyTwoWeekHigh: 280,
        fiftyTwoWeekLow: 200,
        targetMedianPrice: 270,
        targetMeanPrice: 275,
      },
      {
        symbol: 'GOOG',
        longName: 'Alphabet Inc',
        regularMarketPrice: 150,
        regularMarketChange: 1.5,
        regularMarketChangePercent: 1.0,
        marketCap: 1500000000000,
        regularMarketVolume: 60000000,
        averageDailyVolume3Month: 50000000,
        fiftyTwoWeekHigh: 180,
        fiftyTwoWeekLow: 120,
        targetMedianPrice: 170,
        targetMeanPrice: 175,
      },
    ]);

    const request = new NextRequest('http://localhost/api/stock_data/Technology/industry');
    const response = await GET(request, { params: Promise.resolve({ ticker: 'Technology' }) });

    expect(response.status).toBe(200);
    expect(getSectorStocks).toHaveBeenCalledWith('Technology', 50);

    const body = await response.json();
    expect(body.input).toBe('Technology');
    expect(body.industry).toBe('Technology');
    expect(body.stocks).toHaveLength(2);
    expect(body.stocks[0]).toHaveProperty('heatScore');
    expect(body.stocks.map((s: any) => s.symbol).sort()).toEqual(['GOOG', 'MSFT']);
  });

  it('should return empty for non-canonical input without calling Yahoo', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    const request = new NextRequest('http://localhost/api/stock_data/cybersecurity/industry');
    const response = await GET(request, { params: Promise.resolve({ ticker: 'cybersecurity' }) });

    expect(response.status).toBe(200);
    expect(getSectorStocks).not.toHaveBeenCalled();
    expect(yahooFinance.search).not.toHaveBeenCalled();
    expect(yahooFinance.quote).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body.input).toBe('cybersecurity');
    expect(body.stocks).toHaveLength(0);
    expect(body.message).toContain('cybersecurity');
  });

  it('should decode URL-encoded multi-word sectors before dispatching', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (getSectorStocks as jest.Mock).mockResolvedValueOnce([
      { symbol: 'JPM' },
      { symbol: 'V' },
    ]);

    (yahooFinance.quote as jest.Mock).mockResolvedValueOnce([
      {
        symbol: 'JPM',
        longName: 'JPMorgan Chase & Co',
        regularMarketPrice: 200,
        regularMarketChange: 1.2,
        regularMarketChangePercent: 0.6,
        marketCap: 580000000000,
        regularMarketVolume: 15000000,
        averageDailyVolume3Month: 12000000,
        fiftyTwoWeekHigh: 215,
        fiftyTwoWeekLow: 140,
        targetMedianPrice: 220,
        targetMeanPrice: 222,
      },
      {
        symbol: 'V',
        longName: 'Visa Inc',
        regularMarketPrice: 280,
        regularMarketChange: 0.8,
        regularMarketChangePercent: 0.3,
        marketCap: 580000000000,
        regularMarketVolume: 8000000,
        averageDailyVolume3Month: 7000000,
        fiftyTwoWeekHigh: 290,
        fiftyTwoWeekLow: 220,
        targetMedianPrice: 305,
        targetMeanPrice: 308,
      },
    ]);

    const request = new NextRequest('http://localhost/api/stock_data/Financial%20Services/industry');
    const response = await GET(request, { params: Promise.resolve({ ticker: 'Financial%20Services' }) });

    expect(response.status).toBe(200);
    expect(getSectorStocks).toHaveBeenCalledWith('Financial Services', 50);

    const body = await response.json();
    expect(body.input).toBe('Financial Services');
    expect(body.industry).toBe('Financial Services');
    expect(body.stocks).toHaveLength(2);
  });

  it('should handle errors gracefully', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    const mockError = new Error('Yahoo sector screener failed');
    (getSectorStocks as jest.Mock).mockRejectedValueOnce(mockError);

    const request = new NextRequest('http://localhost/api/stock_data/Technology/industry');
    const response = await GET(request, { params: Promise.resolve({ ticker: 'Technology' }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.message).toBe('Internal Server Error');
    expect(createErrorResponse).toHaveBeenCalled();
  });
});
