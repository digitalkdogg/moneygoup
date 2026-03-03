import { GET } from '@/app/api/search/industry/[ticker]/route'; // Adjusted import path
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { categorizeByTaxonomy, getCategoryStrategy, getCategoryKeywords } from '@/utils/industryTaxonomy';

// Mock Next.js and utility functions
jest.mock('next/server', () => ({
  NextRequest: jest.fn(() => ({ url: 'http://localhost/api/search/industry/some_ticker' })), // Mock NextRequest constructor
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


describe('Industry Search API', () => {
  // Before each test, reset mocks
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations for NextResponse.json and unauthorizedResponse
    (NextResponse.json as jest.Mock).mockClear();
    (unauthorizedResponse as jest.Mock).mockClear();
    (unauthorizedResponse as jest.Mock).mockReturnValue({ status: 401, json: () => Promise.resolve({ message: 'Unauthorized' }) });
    
    // Clear yahooFinance mocks
    (yahooFinance.search as jest.Mock).mockClear();
    (yahooFinance.quoteSummary as jest.Mock).mockClear();
    (yahooFinance.screener as jest.Mock).mockClear();
    (yahooFinance.quote as jest.Mock).mockClear();

    // Clear industryTaxonomy mocks
    (categorizeByTaxonomy as jest.Mock).mockClear();
    (getCategoryStrategy as jest.Mock).mockClear();
    (getCategoryKeywords as jest.Mock).mockClear();
  });

  it('should return unauthorized if no session', async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    (checkOrigin as jest.Mock).mockReturnValue(null);

    const request = new NextRequest('http://localhost/api/search/industry/some_ticker');
    // The actual route function expects a second argument for params
    const response = await GET(request, { params: { ticker: 'some_ticker' } });

    expect(getServerSession).toHaveBeenCalled();
    expect(unauthorizedResponse).toHaveBeenCalled();
    // Check the status property of the mock return value
    expect(response.status).toBe(401);
  });

  it('should return an origin error if checkOrigin fails', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    // Mock checkOrigin to return an object that mimics a NextResponse error
    (checkOrigin as jest.Mock).mockReturnValue({
      status: 403,
      json: () => Promise.resolve({ message: 'Invalid Origin' })
    });

    const request = new NextRequest('http://localhost/api/search/industry/some_ticker');
    const response = await GET(request, { params: { ticker: 'some_ticker' } });

    expect(checkOrigin).toHaveBeenCalledWith(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ message: 'Invalid Origin' });
  });

  it('should return a successful response with industry stocks and heat scores', async () => {
    // 1. Set up getServerSession
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    // 2. Set up checkOrigin
    (checkOrigin as jest.Mock).mockReturnValue(null);

    // 3. Mock yahooFinance.search for initial search
    (yahooFinance.search as jest.Mock).mockResolvedValueOnce({
      quotes: [{
        symbol: 'GOOG',
        shortName: 'Alphabet Inc.',
        quoteType: 'EQUITY',
      }],
    });

    // 4. Mock yahooFinance.quoteSummary
    (yahooFinance.quoteSummary as jest.Mock).mockResolvedValueOnce({
      assetProfile: {
        industry: 'Internet Content & Information',
        sector: 'Communication Services',
        longBusinessSummary: 'Alphabet Inc. provides various products and platforms...',
      },
    });

    // 5. Mock categorizeByTaxonomy
    (categorizeByTaxonomy as jest.Mock).mockReturnValue('Technology');

    // 6. Mock getCategoryStrategy (no screenerId, so keywords path)
    (getCategoryStrategy as jest.Mock).mockReturnValue({
      title: 'Technology Sector Stocks',
      screenerId: null,
    });

    // 7. Mock getCategoryKeywords
    (getCategoryKeywords as jest.Mock).mockReturnValue(['Software', 'Internet', 'AI', 'Cloud']);

    // 8. Mock yahooFinance.search for keywords (parallel searches)
    // Need to mock for each keyword search
    (yahooFinance.search as jest.Mock)
      .mockResolvedValueOnce({ quotes: [{ symbol: 'MSFT', quoteType: 'EQUITY' }] }) // Software
      .mockResolvedValueOnce({ quotes: [{ symbol: 'FB', quoteType: 'EQUITY' }] })   // Internet
      .mockResolvedValueOnce({ quotes: [{ symbol: 'NVDA', quoteType: 'EQUITY' }] }) // AI
      .mockResolvedValueOnce({ quotes: [{ symbol: 'AMZN', quoteType: 'EQUITY' }] }) // Cloud
      .mockResolvedValue({ quotes: [] }); // Default for any extra calls, if keywords length > 4

    // 9. Mock yahooFinance.quote for detailed quotes
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
        symbol: 'NVDA',
        longName: 'NVIDIA Corp',
        regularMarketPrice: 150,
        regularMarketChange: 1.5,
        regularMarketChangePercent: 1.0,
        marketCap: 500000000000,
        regularMarketVolume: 60000000,
        averageDailyVolume3Month: 50000000,
        fiftyTwoWeekHigh: 180,
        fiftyTwoWeekLow: 120,
        targetMedianPrice: 170,
        targetMeanPrice: 175,
      },
    ]);

    const request = new NextRequest('http://localhost/api/search/industry/technology');
    const response = await GET(request, { params: { ticker: 'technology' } });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.input).toBe('technology');
    expect(body.industry).toBe('Technology Sector Stocks');
    expect(body.stocks).toHaveLength(2); // Based on the mock data provided
    expect(body.stocks[0]).toHaveProperty('symbol');
    expect(body.stocks[0]).toHaveProperty('heatScore');
    // Add more specific assertions for heatScore and other properties
    expect(body.stocks[0].symbol).toBe('MSFT');
    expect(body.stocks[1].symbol).toBe('NVDA');

    // Due to the complexity of heatScore calculation and normalization,
    // we'll primarily check for its existence and that it's a number.
    // Detailed heatScore validation would require replicating the logic in the test,
    // which might make the test brittle.
    expect(typeof body.stocks[0].heatScore).toBe('number');
    expect(typeof body.stocks[1].heatScore).toBe('number');
  });

  it('should handle no top equities found by yahooFinance.search', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    (yahooFinance.search as jest.Mock).mockResolvedValueOnce({
      quotes: [{
        symbol: 'NOTEQ',
        shortName: 'Not an Equity',
        quoteType: 'ETF', // Not an EQUITY
      }],
    });
    // Ensure subsequent calls also return empty or non-equity data
    (yahooFinance.search as jest.Mock).mockResolvedValue({ quotes: [] });
    (yahooFinance.quoteSummary as jest.Mock).mockResolvedValue({});
    (categorizeByTaxonomy as jest.Mock).mockReturnValue(null); // No category resolved
    (getCategoryStrategy as jest.Mock).mockReturnValue({ title: 'Default Search', screenerId: null });
    (getCategoryKeywords as jest.Mock).mockReturnValue([]);
    (yahooFinance.quote as jest.Mock).mockResolvedValue([]);

    const request = new NextRequest('http://localhost/api/search/industry/nonexistent');
    const response = await GET(request, { params: { ticker: 'nonexistent' } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.input).toBe('nonexistent');
    expect(body.industry).toBe('nonexistent'); // Falls back to decodedInput
    expect(body.stocks).toHaveLength(0);
    expect(body.message).toBe('No specific matches found for "nonexistent".');
  });

  it('should handle no category resolved and fall back to original search results', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    // Initial search returns some equities
    (yahooFinance.search as jest.Mock).mockResolvedValueOnce({
      quotes: [{
        symbol: 'AAPL',
        shortName: 'Apple Inc.',
        quoteType: 'EQUITY',
      }],
    });

    // quoteSummary provides data, but categorizeByTaxonomy fails
    (yahooFinance.quoteSummary as jest.Mock).mockResolvedValueOnce({
      assetProfile: {
        industry: 'Some Industry',
        sector: 'Some Sector',
        longBusinessSummary: 'Some summary',
      },
    });

    (categorizeByTaxonomy as jest.Mock).mockReturnValue(null); // Explicitly no category
    (getCategoryStrategy as jest.Mock).mockReturnValue({ title: 'Default Search', screenerId: null }); // Fallback
    (getCategoryKeywords as jest.Mock).mockReturnValue([]); // No keywords used

    // yahooFinance.quote for the fallback symbols (AAPL in this case)
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

    const request = new NextRequest('http://localhost/api/search/industry/apple');
    const response = await GET(request, { params: { ticker: 'apple' } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.input).toBe('apple');
    expect(body.industry).toBe('apple'); // Should fall back to decodedInput if no category
    expect(body.stocks).toHaveLength(1);
    expect(body.stocks[0].symbol).toBe('AAPL');
    expect(body.stocks[0]).toHaveProperty('heatScore');
  });

  it('should handle errors gracefully', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { email: 'test@example.com' } });
    (checkOrigin as jest.Mock).mockReturnValue(null);

    const mockError = new Error('Yahoo Finance search failed');
    (yahooFinance.search as jest.Mock).mockRejectedValue(mockError);

    const request = new NextRequest('http://localhost/api/search/industry/error_ticker');
    const response = await GET(request, { params: { ticker: 'error_ticker' } });

    expect(response.status).toBe(500); // Assuming createErrorResponse defaults to 500
    const body = await response.json();
    expect(body.message).toBe('Internal Server Error'); // Matches the default message in createErrorResponse mock
    expect(createErrorResponse).toHaveBeenCalledWith(
      expect.any(Error),
      'Internal Server Error'
    );
  });
});