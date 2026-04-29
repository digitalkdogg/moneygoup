import { LimitService } from '../limitService';
import { executeRawQuery } from '../databaseHelper';

// Mock databaseHelper
jest.mock('../databaseHelper', () => ({
  executeRawQuery: jest.fn(),
}));

describe('LimitService', () => {
  const mockUserId = 1;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('canAddWatchlistItem', () => {
    it('allows admin unlimited items', async () => {
      // Mock role_limits query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ max_watchlist_items: null }]]);
      
      const result = await LimitService.canAddWatchlistItem(mockUserId, 'admin');
      expect(result.allowed).toBe(true);
      expect(result.max).toBeNull();
    });

    it('denies user when limit reached (5 items)', async () => {
      // Mock role_limits query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ max_watchlist_items: 5 }]]);
      // Mock count query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ count: 5 }]]);

      const result = await LimitService.canAddWatchlistItem(mockUserId, 'user');
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(5);
      expect(result.max).toBe(5);
      expect(result.code).toBe('LIMIT_EXCEEDED');

      expect(executeRawQuery).toHaveBeenCalledWith(
        expect.stringContaining('is_purchased = 0 AND user_confirmed = 1'),
        [mockUserId]
      );
    });

    it('allows user when under limit (4 items)', async () => {
      // Mock role_limits query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ max_watchlist_items: 5 }]]);
      // Mock count query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ count: 4 }]]);

      const result = await LimitService.canAddWatchlistItem(mockUserId, 'user');
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(4);

      expect(executeRawQuery).toHaveBeenCalledWith(
        expect.stringContaining('is_purchased = 0 AND user_confirmed = 1'),
        [mockUserId]
      );
    });
  });

  describe('canAddPortfolioPosition', () => {
    it('denies superuser when limit reached (10 items)', async () => {
      // Mock role_limits query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ max_portfolio_items: 10 }]]);
      // Mock count query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ count: 10 }]]);

      const result = await LimitService.canAddPortfolioPosition(mockUserId, 'superuser');
      expect(result.allowed).toBe(false);
      expect(result.max).toBe(10);
      expect(result.code).toBe('LIMIT_EXCEEDED');

      expect(executeRawQuery).toHaveBeenCalledWith(
        expect.stringContaining('is_purchased = 1 AND user_confirmed = 1'),
        [mockUserId]
      );
    });

    it('allows superuser when under limit (9 items)', async () => {
      // Mock role_limits query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ max_portfolio_items: 10 }]]);
      // Mock count query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ count: 9 }]]);

      const result = await LimitService.canAddPortfolioPosition(mockUserId, 'superuser');
      expect(result.allowed).toBe(true);

      expect(executeRawQuery).toHaveBeenCalledWith(
        expect.stringContaining('is_purchased = 1 AND user_confirmed = 1'),
        [mockUserId]
      );
    });
  });

  describe('canPerformLookup', () => {
    it('denies user when limit reached (10 in 24h)', async () => {
      // Mock role_limits query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ max_lookups_per_24h: 10 }]]);
      // Mock count query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ count: 10 }]]);

      const result = await LimitService.canPerformLookup(mockUserId, 'user');
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('LIMIT_EXCEEDED');
    });

    it('allows superuser (unlimited lookups)', async () => {
      // Mock role_limits query
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ max_lookups_per_24h: null }]]);
      
      const result = await LimitService.canPerformLookup(mockUserId, 'superuser');
      expect(result.allowed).toBe(true);
      expect(result.max).toBeNull();
    });
  });

  describe('recordLookupEvent', () => {
    it('inserts a lookup event record', async () => {
      await LimitService.recordLookupEvent(mockUserId, 'AAPL', 'test');
      expect(executeRawQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_lookup_events'),
        [mockUserId, 'AAPL', 'test']
      );
    });
  });
});
