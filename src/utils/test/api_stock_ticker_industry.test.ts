import { GET } from '@/app/api/stock_data/[ticker]/industry/route'; // Adjusted import path
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { categorizeByTaxonomy, getCategoryStrategy, getCategoryKeywords } from '@/utils/industryTaxonomy';
import { checkApprovalGuard } from '@/utils/approvalStatus';

// Mock Next.js and utility functions
jest.mock('next/server', () => ({
  NextRequest: jest.fn(() => ({ url: 'http://localhost/api/stock_data/some_ticker/industry' })), // Mock NextRequest constructor
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

// Mock yahooFinanceHelper and industryTaxonomy (initially just the modules)
jest.mock('@/utils/yahooFinanceHelper', () => ({
  yahooFinance: {
    search: jest.fn(),
    quoteSummary: jest.fn(),
    screener: jest.fn(),
    quote: jest.fn(),
  },
}));

jest.mock('@/utils/industryTaxonomy', () => ({
  categorizeByTaxonomy: jest.fn(),
  getCategoryStrategy: jest.fn(),
  getCategoryKeywords: jest.fn(),
}));
jest.mock('@/utils/approvalStatus', () => ({
  checkApprovalGuard: jest.fn().mockResolvedValue({ allowed: true }),
}));


describe('Industry Search API', () => {
  // Before each test, reset mocks
  beforeEach(() => {
    jest.resetAllMocks();
    (checkApprovalGuard as jest.Mock).mockResolvedValue({ allowed: true });

    // Reset mock implementations for NextResponse.json and unauthorizedResponse
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

    const request = new NextRequest('http://localhost/api/stock_data/some_ticker/industry');
    const response = await GET(request, { params: { ticker: 'some_ticker' } });

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

    const request = new NextRequest('http://localhost/api/stock_data/some_ticker/industry');
    const response = await GET(request, { params: { ticker: 'some_ticker' } });

    expect(checkOrigin).toHaveBeenCalledWith(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ message: 'Invalid Origin' });
  });

  it('should return a successful response with industry stocks and heat scores', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    // Mock categorizeByTaxonomy to match a category
    (categorizeByTaxonomy as jest.Mock).mockReturnValue('Technology');

    // Mock getCategoryStrategy (no screenerId, so keywords path)
    (getCategoryStrategy as jest.Mock).mockReturnValue({
      title: 'Technology Sector Stocks',
      screenerId: null,
    });

    // Mock getCategoryKeywords
    (getCategoryKeywords as jest.Mock).mockReturnValue(['Software', 'Internet']);

    // Mock yahooFinance.search for keywords
    (yahooFinance.search as jest.Mock)
      .mockResolvedValueOnce({ quotes: [{ symbol: 'MSFT', quoteType: 'EQUITY' }] })
      .mockResolvedValueOnce({ quotes: [{ symbol: 'GOOG', quoteType: 'EQUITY' }] });

    // Mock yahooFinance.quote for detailed quotes
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

    const request = new NextRequest('http://localhost/api/stock_data/technology/industry');
    const response = await GET(request, { params: { ticker: 'technology' } });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.input).toBe('technology');
    expect(body.industry).toBe('Technology Sector Stocks');
    expect(body.stocks).toHaveLength(2);
    expect(body.stocks[0]).toHaveProperty('heatScore');
    expect(body.stocks[0].symbol).toBe('MSFT');
    expect(body.stocks[1].symbol).toBe('GOOG');
  });

  it('should handle no top equities found by yahooFinance.search', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (categorizeByTaxonomy as jest.Mock).mockReturnValue(null); // No category resolved

    (yahooFinance.search as jest.Mock).mockResolvedValueOnce({
      quotes: [{
        symbol: 'NOTEQ',
        shortName: 'Not an Equity',
        quoteType: 'ETF', // Not an EQUITY
      }],
    });

    const request = new NextRequest('http://localhost/api/stock_data/nonexistent/industry');
    const response = await GET(request, { params: { ticker: 'nonexistent' } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.input).toBe('nonexistent');
    expect(body.stocks).toHaveLength(0);
    expect(body.message).toBe('No specific matches found for "nonexistent".');
  });

  it('should handle no category resolved and fall back to original search results', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (categorizeByTaxonomy as jest.Mock).mockReturnValue(null); // Explicitly no category

    // Fallback search returns an equity
    (yahooFinance.search as jest.Mock).mockResolvedValueOnce({
      quotes: [{
        symbol: 'AAPL',
        shortName: 'Apple Inc.',
        quoteType: 'EQUITY',
      }],
    });

    // yahooFinance.quote for the fallback symbols
    (yahooFinance.quote as jest.Mock).mockResolvedValueOnce([
      {
        symbol: 'AAPL',
        longName: 'Apple Inc.',
        regularMarketPrice: 170,
        regularMarketChange: 1.7,
        regularMarketChangePercent: 1.0,
        marketCap: 2800000000000,
        regularMarketVolume: 80000000,
        averageDailyVolume3Month: 70000000,
        fiftyTwoWeekHigh: 180,
        fiftyTwoWeekLow: 120,
        targetMedianPrice: 190,
        targetMeanPrice: 195,
      },
    ]);

    const request = new NextRequest('http://localhost/api/stock_data/apple/industry');
    const response = await GET(request, { params: { ticker: 'apple' } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.input).toBe('apple');
    expect(body.stocks).toHaveLength(1);
    expect(body.stocks[0].symbol).toBe('AAPL');
  });

  it('should handle errors gracefully', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (categorizeByTaxonomy as jest.Mock).mockReturnValue(null);

    const mockError = new Error('Yahoo Finance search failed');
    (yahooFinance.search as jest.Mock).mockRejectedValue(mockError);

    const request = new NextRequest('http://localhost/api/stock_data/error_ticker/industry');
    const response = await GET(request, { params: { ticker: 'error_ticker' } });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.message).toBe('Internal Server Error');
    expect(createErrorResponse).toHaveBeenCalled();
  });
});