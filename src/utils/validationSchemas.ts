/**
 * Zod validation schemas for API parameters and request bodies
 * Centralized validation ensures consistent input sanitization across endpoints
 */

import { z } from 'zod';

/**
 * Ticker symbol validation
 * Allows: A-Z alphanumeric and common ticker symbols (., -, ^)
 * Examples: AAPL, BRK.B, ^GSPC, GE-
 */
export const tickerSchema = z
  .string()
  .min(1, 'Ticker is required')
  .max(10, 'Ticker must be 10 characters or less')
  .regex(/^[A-Z0-9.^-]{1,10}$/, 'Invalid ticker format (alphanumeric, dots, carets, hyphens only)')
  .toUpperCase();

/**
 * Historical data period validation
 * Only allow known periods to prevent injection attacks
 */
export const periodSchema = z
  .enum(['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y', 'max'])
  .default('1y');

/**
 * Stock ID validation
 * Prevents negative IDs and extremely large values
 */
export const stockIdSchema = z
  .coerce
  .number()
  .int('Stock ID must be an integer')
  .positive('Stock ID must be greater than 0')
  .max(2147483647, 'Stock ID exceeds maximum allowed value');

/**
 * User ID validation
 * Expects UUIDs from NextAuth
 */
export const userIdSchema = z
  .string()
  .min(1, 'User ID is required')
  .max(255, 'User ID is too long');

/**
 * Number of shares validation
 * Prevents negative or zero shares, and unrealistic quantities
 */
export const sharesSchema = z
  .coerce
  .number()
  .positive('Shares must be greater than 0')
  .max(1000000, 'Shares quantity is unrealistic');

/**
 * Price validation
 * Prevents negative prices and unrealistic amounts
 */
export const priceSchema = z
  .coerce
  .number()
  .nonnegative('Price cannot be negative')
  .max(1000000, 'Price is unrealistic');

/**
 * Username validation
 * Alphanumeric, underscore, hyphen. 3-50 characters.
 */
export const usernameSchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(50, 'Username must be 50 characters or less')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens');

/**
 * Email validation
 */
export const emailSchema = z
  .string()
  .email('Invalid email format')
  .max(255, 'Email is too long');

/**
 * Password validation
 * Minimum 8 characters, must include uppercase, lowercase, number
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[0-9]/, 'Password must include a number');

/**
 * Company name validation
 * Allows alphanumeric, spaces, common punctuation
 */
export const companyNameSchema = z
  .string()
  .min(1, 'Company name is required')
  .max(200, 'Company name must be 200 characters or less')
  .regex(/^[a-zA-Z0-9\s&.,'-]+$/, 'Company name contains invalid characters');

/**
 * Notes/comments validation
 * Allows more characters but limits length
 */
export const notesSchema = z
  .string()
  .max(500, 'Notes must be 500 characters or less')
  .optional();

/**
 * Query string validation
 * For search queries, news searches, etc.
 */
export const searchQuerySchema = z
  .string()
  .min(1, 'Search query is required')
  .max(200, 'Search query must be 200 characters or less');

/**
 * Limit and offset for pagination
 */
export const limitSchema = z
  .coerce
  .number()
  .int('Limit must be an integer')
  .min(1, 'Limit must be at least 1')
  .max(100, 'Limit must not exceed 100')
  .default(20);

export const offsetSchema = z
  .coerce
  .number()
  .int('Offset must be an integer')
  .nonnegative('Offset cannot be negative')
  .max(100000, 'Offset is too large')
  .default(0);

/**
 * Combined schema for registration
 */
export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

/**
 * Combined schema for login
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
