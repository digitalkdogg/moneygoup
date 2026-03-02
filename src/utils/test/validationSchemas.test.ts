import {
  tickerSchema,
  periodSchema,
  stockIdSchema,
  usernameSchema,
  passwordSchema
} from '../validationSchemas';

describe('validationSchemas', () => {
  describe('tickerSchema', () => {
    test('accepts valid tickers', () => {
      expect(tickerSchema.parse('AAPL')).toBe('AAPL');
      expect(tickerSchema.parse('BRK.B')).toBe('BRK.B');
      expect(tickerSchema.parse('^GSPC')).toBe('^GSPC');
    });

    test('rejects invalid tickers', () => {
      expect(() => tickerSchema.parse('')).toThrow();
      expect(() => tickerSchema.parse('TOOLONGTICKER')).toThrow();
      expect(() => tickerSchema.parse('INVALID!')).toThrow();
    });
  });

  describe('periodSchema', () => {
    test('accepts valid periods', () => {
      expect(periodSchema.parse('1y')).toBe('1y');
      expect(periodSchema.parse('max')).toBe('max');
    });

    test('rejects invalid periods', () => {
      expect(() => periodSchema.parse('2y')).toThrow();
    });
  });

  describe('usernameSchema', () => {
    test('accepts valid usernames', () => {
      expect(usernameSchema.parse('user_123')).toBe('user_123');
    });

    test('rejects invalid usernames', () => {
      expect(() => usernameSchema.parse('us')).toThrow(); // Too short
      expect(() => usernameSchema.parse('user!name')).toThrow(); // Invalid char
    });
  });

  describe('passwordSchema', () => {
    test('accepts strong passwords', () => {
      expect(passwordSchema.parse('Password123')).toBe('Password123');
    });

    test('rejects weak passwords', () => {
      expect(() => passwordSchema.parse('weak')).toThrow();
      expect(() => passwordSchema.parse('alllowercase1')).toThrow();
      expect(() => passwordSchema.parse('ALLUPPERCASE1')).toThrow();
      expect(() => passwordSchema.parse('NoNumberCase')).toThrow();
    });
  });
});
