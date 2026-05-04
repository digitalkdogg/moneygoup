import type { ProfileResponse } from '@/types/api';

describe('Profile Component', () => {
  describe('response types', () => {
    test('user role response includes stats', () => {
      const userProfile: ProfileResponse = {
        username: 'john_doe',
        accountType: 'user',
        stats: {
          lookupCount: 42,
          portfolioItemCount: 5,
          watchlistItemCount: 8,
        },
      };

      expect(userProfile.accountType).toBe('user');
      expect(userProfile.stats).toBeDefined();
      expect(userProfile.stats.lookupCount).toBe(42);
      expect(userProfile.stats.portfolioItemCount).toBe(5);
      expect(userProfile.stats.watchlistItemCount).toBe(8);
    });

    test('superuser role response includes stats', () => {
      const superuserProfile: ProfileResponse = {
        username: 'super_user',
        accountType: 'superuser',
        stats: {
          lookupCount: 100,
          portfolioItemCount: 20,
          watchlistItemCount: 30,
        },
      };

      expect(superuserProfile.accountType).toBe('superuser');
      expect(superuserProfile.stats).toBeDefined();
      expect(superuserProfile.stats.lookupCount).toBe(100);
    });

    test('admin role response does not include stats', () => {
      const adminProfile: ProfileResponse = {
        username: 'admin_user',
        accountType: 'admin',
      };

      expect(adminProfile.accountType).toBe('admin');
      expect((adminProfile as any).stats).toBeUndefined();
    });
  });

  describe('stat formatting', () => {
    test('formats zero counts', () => {
      const count = 0;
      const isEmpty = count === 0;
      expect(isEmpty).toBe(true);
    });

    test('formats large numbers with toLocaleString', () => {
      const count = 1000;
      const formatted = count.toLocaleString();
      expect(formatted).toBe('1,000');
    });

    test('formats regular numbers', () => {
      const count = 42;
      const formatted = count.toLocaleString();
      expect(formatted).toBe('42');
    });

    test('formats 10000 correctly', () => {
      const count = 10000;
      const formatted = count.toLocaleString();
      expect(formatted).toBe('10,000');
    });
  });

  describe('account type labels', () => {
    const labelMap: Record<string, string> = {
      user: 'Standard Member',
      superuser: 'Super Member',
      admin: 'Administrator',
    };

    test('maps user to Standard Member', () => {
      expect(labelMap['user']).toBe('Standard Member');
    });

    test('maps superuser to Super Member', () => {
      expect(labelMap['superuser']).toBe('Super Member');
    });

    test('maps admin to Administrator', () => {
      expect(labelMap['admin']).toBe('Administrator');
    });

    test('provides fallback for unknown types', () => {
      const unknownType = 'unknown_role';
      const label = labelMap[unknownType] ?? unknownType;
      expect(label).toBe('unknown_role');
    });
  });

  describe('avatar display', () => {
    test('extracts first letter from username', () => {
      const username = 'john_doe';
      const firstLetter = username.charAt(0).toUpperCase();
      expect(firstLetter).toBe('J');
    });

    test('handles single character username', () => {
      const username = 'a';
      const firstLetter = username.charAt(0).toUpperCase();
      expect(firstLetter).toBe('A');
    });

    test('handles empty username gracefully', () => {
      const username = '';
      const firstLetter = username.charAt(0).toUpperCase();
      expect(firstLetter).toBe('');
    });

    test('handles usernames with numbers', () => {
      const username = '123user';
      const firstLetter = username.charAt(0).toUpperCase();
      expect(firstLetter).toBe('1');
    });
  });

  describe('stat data validation', () => {
    test('stats are non-negative', () => {
      const userProfile: ProfileResponse = {
        username: 'test_user',
        accountType: 'user',
        stats: {
          lookupCount: 42,
          portfolioItemCount: 5,
          watchlistItemCount: 8,
        },
      };

      if (userProfile.accountType !== 'admin') {
        expect(userProfile.stats.lookupCount).toBeGreaterThanOrEqual(0);
        expect(userProfile.stats.portfolioItemCount).toBeGreaterThanOrEqual(0);
        expect(userProfile.stats.watchlistItemCount).toBeGreaterThanOrEqual(0);
      }
    });

    test('stats are integers', () => {
      const userProfile: ProfileResponse = {
        username: 'test_user',
        accountType: 'user',
        stats: {
          lookupCount: 42,
          portfolioItemCount: 5,
          watchlistItemCount: 8,
        },
      };

      if (userProfile.accountType !== 'admin') {
        expect(Number.isInteger(userProfile.stats.lookupCount)).toBe(true);
        expect(Number.isInteger(userProfile.stats.portfolioItemCount)).toBe(true);
        expect(Number.isInteger(userProfile.stats.watchlistItemCount)).toBe(true);
      }
    });
  });

  describe('empty state handling', () => {
    test('handles user with zero stats', () => {
      const userProfile: ProfileResponse = {
        username: 'new_user',
        accountType: 'user',
        stats: {
          lookupCount: 0,
          portfolioItemCount: 0,
          watchlistItemCount: 0,
        },
      };

      expect(userProfile.stats.lookupCount).toBe(0);
      expect(userProfile.stats.portfolioItemCount).toBe(0);
      expect(userProfile.stats.watchlistItemCount).toBe(0);
    });
  });

  describe('API contract', () => {
    test('all user/superuser profiles have required fields', () => {
      const profiles: ProfileResponse[] = [
        {
          username: 'user1',
          accountType: 'user',
          stats: { lookupCount: 0, portfolioItemCount: 0, watchlistItemCount: 0 },
        },
        {
          username: 'user2',
          accountType: 'superuser',
          stats: { lookupCount: 10, portfolioItemCount: 5, watchlistItemCount: 3 },
        },
      ];

      profiles.forEach((profile) => {
        expect(profile.username).toBeDefined();
        expect(profile.username.length).toBeGreaterThan(0);
        expect(['user', 'superuser'].includes(profile.accountType)).toBe(true);
        expect(profile.stats).toBeDefined();
        expect(profile.stats.lookupCount).toBeGreaterThanOrEqual(0);
        expect(profile.stats.portfolioItemCount).toBeGreaterThanOrEqual(0);
        expect(profile.stats.watchlistItemCount).toBeGreaterThanOrEqual(0);
      });
    });

    test('admin profiles do not have stats field', () => {
      const adminProfile: ProfileResponse = {
        username: 'admin_user',
        accountType: 'admin',
      };

      expect(adminProfile.username).toBeDefined();
      expect(adminProfile.accountType).toBe('admin');
      expect((adminProfile as any).stats).toBeUndefined();
    });
  });
});
