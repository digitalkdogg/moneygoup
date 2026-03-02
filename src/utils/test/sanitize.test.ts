import {
  sanitizeUsername,
  sanitizeCompanyName,
  sanitizeText,
  sanitizeTicker,
  sanitizeEmail,
  sanitizeNumber,
  escapeHtml,
  sanitizeJson
} from '../sanitize';

describe('sanitize', () => {
  describe('sanitizeUsername', () => {
    test('removes special characters', () => {
      expect(sanitizeUsername('user!@#name')).toBe('username');
    });

    test('allows underscores and hyphens', () => {
      expect(sanitizeUsername('user_name-123')).toBe('user_name-123');
    });

    test('limits length to 50', () => {
      const longName = 'a'.repeat(60);
      expect(sanitizeUsername(longName).length).toBe(50);
    });

    test('handles non-string input', () => {
      expect(sanitizeUsername(null as any)).toBe('');
    });
  });

  describe('sanitizeCompanyName', () => {
    test('removes HTML tags', () => {
      expect(sanitizeCompanyName('<b>Company</b>')).toBe('Company');
    });

    test('allows common business characters', () => {
      expect(sanitizeCompanyName('AT&T, Inc.')).toBe('AT&T, Inc.');
    });

    test('limits length to 200', () => {
      const longName = 'a'.repeat(210);
      expect(sanitizeCompanyName(longName).length).toBe(200);
    });
  });

  describe('sanitizeText', () => {
    test('removes HTML tags', () => {
      expect(sanitizeText('Hello <script>alert(1)</script> world')).toBe('Hello alert(1) world');
    });

    test('limits length to 500', () => {
      const longText = 'a'.repeat(510);
      expect(sanitizeText(longText).length).toBe(500);
    });
  });

  describe('sanitizeTicker', () => {
    test('converts to uppercase and removes invalid characters', () => {
      expect(sanitizeTicker('aapl!@')).toBe('AAPL');
    });

    test('allows dots, carets, and hyphens', () => {
      expect(sanitizeTicker('BRK.B^')).toBe('BRK.B^');
    });

    test('limits length to 10', () => {
      expect(sanitizeTicker('VERYLONGTICKER').length).toBe(10);
    });
  });

  describe('sanitizeEmail', () => {
    test('trims and lowercases', () => {
      expect(sanitizeEmail('  Test@Example.Com  ')).toBe('test@example.com');
    });
  });

  describe('sanitizeNumber', () => {
    test('converts valid strings to numbers', () => {
      expect(sanitizeNumber('123.45')).toBe(123.45);
    });

    test('returns 0 for invalid input', () => {
      expect(sanitizeNumber('abc')).toBe(0);
    });
  });

  describe('escapeHtml', () => {
    test('escapes HTML special characters', () => {
      expect(escapeHtml('& < > " \' /')).toBe('&amp; &lt; &gt; &quot; &#x27; &#x2F;');
    });
  });

  describe('sanitizeJson', () => {
    test('returns valid JSON string', () => {
      const json = '{"key":"value"}';
      expect(sanitizeJson(json)).toBe(json);
    });

    test('returns empty object for invalid JSON', () => {
      expect(sanitizeJson('invalid')).toBe('{}');
    });
  });
});
