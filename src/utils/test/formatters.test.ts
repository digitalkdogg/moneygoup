import { formatNumber, formatCurrency } from '../formatters';

describe('formatters', () => {
  describe('formatNumber', () => {
    test('formats regular numbers with default decimals', () => {
      expect(formatNumber(1234.567)).toBe('1,234.57');
    });

    test('formats numbers with custom decimals', () => {
      expect(formatNumber(1234.567, 3)).toBe('1,234.567');
    });

    test('handles null and undefined', () => {
      expect(formatNumber(null)).toBe('N/A');
      expect(formatNumber(undefined)).toBe('N/A');
    });

    test('handles NaN', () => {
      expect(formatNumber(NaN)).toBe('N/A');
    });

    test('handles string input that is numeric', () => {
      expect(formatNumber('1234.56' as any)).toBe('1,234.56');
    });

    test('handles non-numeric string input', () => {
      expect(formatNumber('abc' as any)).toBe('N/A');
    });

    test('strips trailing zeros when requested', () => {
      expect(formatNumber(1234.00, 2, true)).toBe('1,234');
      expect(formatNumber(1234.50, 2, true)).toBe('1,234.50'); // Only strips if ALL decimals are zero
    });

    test('does not strip trailing zeros if not requested', () => {
      expect(formatNumber(1234.00, 2, false)).toBe('1,234.00');
    });
  });

  describe('formatCurrency', () => {
    test('formats regular currency', () => {
      expect(formatCurrency(1234.56)).toBe('$1,234.56');
    });

    test('handles null, undefined and NaN', () => {
      expect(formatCurrency(null)).toBe('N/A');
      expect(formatCurrency(undefined)).toBe('N/A');
      expect(formatCurrency(NaN)).toBe('N/A');
    });

    test('formats currency with custom decimals', () => {
      expect(formatCurrency(1234.567, 0)).toBe('$1,235');
    });
  });
});
