import { executeRawQuery } from './databaseHelper';
import { createLogger } from './logger';

const logger = createLogger('limitService');

export type LimitDimension = 'watchlist' | 'portfolio' | 'lookups';

export interface LimitCheckResult {
  allowed: boolean;
  max: number | null; // null means unlimited
  current: number;
  code?: 'LIMIT_EXCEEDED';
  dimension?: LimitDimension;
}

// Default limits in case database table is empty or inaccessible
const DEFAULT_LIMITS: Record<string, Record<LimitDimension, number | null>> = {
  user: {
    watchlist: 5,
    portfolio: 5,
    lookups: 10,
  },
  superuser: {
    watchlist: 10,
    portfolio: 10,
    lookups: null,
  },
  admin: {
    watchlist: null,
    portfolio: null,
    lookups: null,
  },
};

/**
 * LimitService provides centralized role-based limit enforcement.
 */
export class LimitService {
  /**
   * Fetches the limit for a specific role and dimension from the database or defaults.
   */
  private static async getLimit(role: string, dimension: LimitDimension): Promise<number | null> {
    try {
      const [rows]: any = await executeRawQuery(
        'SELECT max_watchlist_items, max_portfolio_items, max_lookups_per_24h FROM role_limits WHERE role = ?',
        [role]
      );

      if (Array.isArray(rows) && rows.length > 0) {
        const limits = rows[0];
        switch (dimension) {
          case 'watchlist': return limits.max_watchlist_items;
          case 'portfolio': return limits.max_portfolio_items;
          case 'lookups': return limits.max_lookups_per_24h;
        }
      }
    } catch (error) {
      logger.error('Failed to fetch limits from database, falling back to defaults', { role, dimension, error });
    }

    return DEFAULT_LIMITS[role]?.[dimension] ?? (role === 'admin' ? null : DEFAULT_LIMITS.user[dimension]);
  }

  /**
   * Checks if a user can add a watchlist item.
   */
  static async canAddWatchlistItem(userId: string | number, role: string): Promise<LimitCheckResult> {
    const max = await this.getLimit(role, 'watchlist');
    if (max === null) return { allowed: true, max, current: 0 };

    const [rows]: any = await executeRawQuery(
      'SELECT COUNT(*) as count FROM user_stocks WHERE user_id = ? AND is_purchased = 0 AND user_confirmed = 1',
      [userId]
    );
    const current = rows[0]?.count || 0;

    return {
      allowed: current < max,
      max,
      current,
      ...(current >= max ? { code: 'LIMIT_EXCEEDED', dimension: 'watchlist' } : {}),
    };
  }

  /**
   * Checks if a user can add a portfolio position.
   */
  static async canAddPortfolioPosition(userId: string | number, role: string): Promise<LimitCheckResult> {
    const max = await this.getLimit(role, 'portfolio');
    if (max === null) return { allowed: true, max, current: 0 };

    const [rows]: any = await executeRawQuery(
      'SELECT COUNT(*) as count FROM user_stocks WHERE user_id = ? AND is_purchased = 1 AND user_confirmed = 1',
      [userId]
    );
    const current = rows[0]?.count || 0;

    return {
      allowed: current < max,
      max,
      current,
      ...(current >= max ? { code: 'LIMIT_EXCEEDED', dimension: 'portfolio' } : {}),
    };
  }

  /**
   * Checks if a user can perform a stock lookup.
   */
  static async canPerformLookup(userId: string | number, role: string): Promise<LimitCheckResult> {
    const max = await this.getLimit(role, 'lookups');
    if (max === null) return { allowed: true, max, current: 0 };

    const [rows]: any = await executeRawQuery(
      'SELECT COUNT(*) as count FROM user_lookup_events WHERE user_id = ? AND looked_up_at > UTC_TIMESTAMP() - INTERVAL 1 DAY',
      [userId]
    );
    const current = rows[0]?.count || 0;

    return {
      allowed: current < max,
      max,
      current,
      ...(current >= max ? { code: 'LIMIT_EXCEEDED', dimension: 'lookups' } : {}),
    };
  }

  /**
   * Records a lookup event for a user.
   */
  static async recordLookupEvent(userId: string | number, ticker: string, source: string = 'api'): Promise<void> {
    try {
      await executeRawQuery(
        'INSERT INTO user_lookup_events (user_id, ticker, source) VALUES (?, ?, ?)',
        [userId, ticker, source]
      );
    } catch (error) {
      logger.error('Failed to record lookup event', { userId, ticker, error });
    }
  }
}
