import { NextRequest } from 'next/server';
import { GET } from '@/app/api/user/profile/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';

jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/originCheck');
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

const makeRequest = (url: string): NextRequest =>
  ({
    headers: new Headers(),
    url,
  } as unknown as NextRequest);

describe('GET /api/user/profile', () => {
  let mockRequest: NextRequest;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkOrigin as jest.Mock).mockReturnValue(null);
    mockRequest = makeRequest('http://localhost/api/user/profile');
  });

  describe('authentication', () => {
    test('returns 401 when origin check fails', async () => {
      (checkOrigin as jest.Mock).mockReturnValue({
        status: 403,
        json: async () => ({ error: 'Invalid origin' }),
      });

      const response = await GET(mockRequest);
      expect(response.status).toBe(403);
    });

    test('returns 401 when no session', async () => {
      (getServerSession as jest.Mock).mockResolvedValue(null);

      const response = await GET(mockRequest);
      expect(response.status).toBe(401);
    });

    test('returns 401 when session has no user.id', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { name: 'John' },
      });

      const response = await GET(mockRequest);
      expect(response.status).toBe(401);
    });

    test('returns 401 when user not found in database', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '999' },
      });
      (executeRawQuery as jest.Mock).mockResolvedValue([[]]);

      const response = await GET(mockRequest);
      expect(response.status).toBe(401);
    });
  });

  describe('admin role', () => {
    beforeEach(() => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '1', role: 'admin' },
      });
      (executeRawQuery as jest.Mock).mockResolvedValue([
        [{ username: 'admin_user' }],
      ]);
    });

    test('returns profile without stats for admin', async () => {
      const response = await GET(mockRequest);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({
        username: 'admin_user',
        accountType: 'admin',
        strategy: { aggressiveness: 'neutral', investment_timeframe: '1_month' },
      });
      expect(data.stats).toBeUndefined();
    });

    test('queries username from database', async () => {
      await GET(mockRequest);

      expect(executeRawQuery).toHaveBeenCalledWith(
        'SELECT username FROM users WHERE id = ?',
        ['1']
      );
    });
  });

  describe('user role', () => {
    beforeEach(() => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '2', role: 'user' },
      });
    });

    test('returns profile with stats for user', async () => {
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ username: 'john_doe' }]])         // username query
        .mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]])     // strategy query
        .mockResolvedValueOnce([[{ cnt: '42' }]])                    // lookup count
        .mockResolvedValueOnce([[{ cnt: '5' }]])                     // portfolio count
        .mockResolvedValueOnce([[{ cnt: '8' }]]);                    // watchlist count

      const response = await GET(mockRequest);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({
        username: 'john_doe',
        accountType: 'user',
        stats: {
          lookupCount: 42,
          portfolioItemCount: 5,
          watchlistItemCount: 8,
        },
        strategy: { aggressiveness: 'neutral', investment_timeframe: '1_month' },
      });
    });

    test('returns zero counts when no data', async () => {
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ username: 'new_user' }]])
        .mockResolvedValueOnce([[]])  // no strategy row → defaults to neutral
        .mockResolvedValueOnce([[]])  // no lookups
        .mockResolvedValueOnce([[]])  // no portfolio
        .mockResolvedValueOnce([[]]); // no watchlist

      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.stats).toEqual({
        lookupCount: 0,
        portfolioItemCount: 0,
        watchlistItemCount: 0,
      });
    });

    test('executes COUNT queries with correct SQL', async () => {
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ username: 'john_doe' }]])
        .mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]])
        .mockResolvedValueOnce([[{ cnt: '42' }]])
        .mockResolvedValueOnce([[{ cnt: '5' }]])
        .mockResolvedValueOnce([[{ cnt: '8' }]]);

      await GET(mockRequest);

      const calls = (executeRawQuery as jest.Mock).mock.calls;
      // First call: username
      expect(calls[0][0]).toBe('SELECT username FROM users WHERE id = ?');

      // Second call: investment strategy lookup
      expect(calls[1][0]).toContain('user_investment_strategy');

      // Third call: lookup count
      expect(calls[2][0]).toContain('user_lookup_events');
      expect(calls[2][0]).toContain('user_id = ?');

      // Fourth call: portfolio count
      expect(calls[3][0]).toContain('user_stocks');
      expect(calls[3][0]).toContain('is_purchased = 1');
      expect(calls[3][0]).toContain('is_active = 1');
      expect(calls[3][0]).toContain('shares > 0');

      // Fifth call: watchlist count
      expect(calls[4][0]).toContain('user_stocks');
      expect(calls[4][0]).toContain('is_purchased = 0');
      expect(calls[4][0]).toContain('is_active = 1');
      expect(calls[4][0]).toContain('user_confirmed = 1');
    });
  });

  describe('superuser role', () => {
    beforeEach(() => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '3', role: 'superuser' },
      });
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ username: 'super_user' }]])
        .mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]])
        .mockResolvedValueOnce([[{ cnt: '100' }]])
        .mockResolvedValueOnce([[{ cnt: '15' }]])
        .mockResolvedValueOnce([[{ cnt: '20' }]]);
    });

    test('returns profile with stats for superuser', async () => {
      const response = await GET(mockRequest);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({
        username: 'super_user',
        accountType: 'superuser',
        stats: {
          lookupCount: 100,
          portfolioItemCount: 15,
          watchlistItemCount: 20,
        },
        strategy: { aggressiveness: 'neutral', investment_timeframe: '1_month' },
      });
    });
  });

  describe('edge cases', () => {
    test('handles COUNT results as strings (mysql2 behavior)', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '4', role: 'user' },
      });
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ username: 'test_user' }]])
        .mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]])
        .mockResolvedValueOnce([[{ cnt: '999' }]]) // string count
        .mockResolvedValueOnce([[{ cnt: '10' }]])
        .mockResolvedValueOnce([[{ cnt: '5' }]]);

      const response = await GET(mockRequest);
      const data = await response.json();

      // Should be converted to numbers
      expect(typeof data.stats.lookupCount).toBe('number');
      expect(data.stats.lookupCount).toBe(999);
    });

    test('handles unknown role as user-type (falls through to stats)', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '5', role: 'unknown_role' },
      });
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ username: 'weird_user' }]])
        .mockResolvedValueOnce([[{ aggressiveness: 'neutral' }]])
        .mockResolvedValueOnce([[{ cnt: '1' }]])
        .mockResolvedValueOnce([[{ cnt: '1' }]])
        .mockResolvedValueOnce([[{ cnt: '1' }]]);

      const response = await GET(mockRequest);
      const data = await response.json();

      // Should have stats because unknown role falls through to user path
      expect(data.stats).toBeDefined();
    });

    test('returns 500 on database error', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '6', role: 'user' },
      });
      (executeRawQuery as jest.Mock).mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await GET(mockRequest);
      expect(response.status).toBe(500);

      const data = await response.json();
      expect(data.message).toContain('Error fetching user profile');
    });
  });

  describe('data scoping', () => {
    test('always uses session.user.id for queries (prevents cross-user access)', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: '100', role: 'user' },
      });
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ username: 'user_100' }]])
        .mockResolvedValueOnce([[{ cnt: '0' }]])
        .mockResolvedValueOnce([[{ cnt: '0' }]])
        .mockResolvedValueOnce([[{ cnt: '0' }]]);

      await GET(mockRequest);

      const calls = (executeRawQuery as jest.Mock).mock.calls;
      // All calls should use user_id = 100
      calls.forEach((call) => {
        const [sql, params] = call;
        if (sql.includes('WHERE')) {
          expect(params).toContain('100');
        }
      });
    });
  });
});
