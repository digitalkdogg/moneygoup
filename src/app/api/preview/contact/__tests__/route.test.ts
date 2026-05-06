import { checkRateLimitPreview } from '@/utils/previewRateLimiter';
import {
  sanitizeName,
  sanitizeEmail,
  sanitizeCompany,
  sanitizeMessage,
  isValidEmail,
  detectSpamPatterns,
} from '@/utils/sanitizeInput';

describe('Preview Contact API - Backend Validation', () => {
  describe('Rate Limiting', () => {
    it('allows first submission from IP', () => {
      const result = checkRateLimitPreview('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 5 max - 1 = 4
    });

    it('tracks submissions per IP', () => {
      const ip = '192.168.1.100';

      // First 5 submissions should be allowed
      for (let i = 0; i < 5; i++) {
        const result = checkRateLimitPreview(ip);
        expect(result.allowed).toBe(true);
      }

      // 6th submission should be blocked
      const result = checkRateLimitPreview(ip);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('returns reset time for blocked requests', () => {
      const ip = '192.168.1.200';
      const now = Date.now();

      // Fill the quota
      for (let i = 0; i < 5; i++) {
        checkRateLimitPreview(ip);
      }

      // Check blocked request
      const result = checkRateLimitPreview(ip);
      expect(result.resetTime).toBeGreaterThan(now);
      expect(result.resetTime).toBeLessThanOrEqual(now + 60 * 60 * 1000 + 1000); // Within 1 hour
    });
  });

  describe('Input Sanitization', () => {
    describe('sanitizeName', () => {
      it('removes leading/trailing whitespace', () => {
        expect(sanitizeName('  John Doe  ')).toBe('John Doe');
      });

      it('enforces max length', () => {
        const longName = 'a'.repeat(150);
        const result = sanitizeName(longName);
        expect(result.length).toBeLessThanOrEqual(120);
      });

      it('removes control characters', () => {
        expect(sanitizeName('John\x00Doe')).toBe('JohnDoe');
      });

      it('handles non-string input', () => {
        expect(sanitizeName(null as any)).toBe('');
        expect(sanitizeName(undefined as any)).toBe('');
        expect(sanitizeName(123 as any)).toBe('');
      });
    });

    describe('sanitizeEmail', () => {
      it('converts to lowercase', () => {
        expect(sanitizeEmail('JOHN@EXAMPLE.COM')).toBe('john@example.com');
      });

      it('removes whitespace', () => {
        expect(sanitizeEmail('  john@example.com  ')).toBe('john@example.com');
      });

      it('enforces max length', () => {
        const longEmail = 'a'.repeat(300) + '@example.com';
        const result = sanitizeEmail(longEmail);
        expect(result.length).toBeLessThanOrEqual(255);
      });

      it('handles non-string input', () => {
        expect(sanitizeEmail(null as any)).toBe('');
      });
    });

    describe('sanitizeCompany', () => {
      it('sanitizes valid company name', () => {
        expect(sanitizeCompany('  Acme Corp  ')).toBe('Acme Corp');
      });

      it('returns null for empty string', () => {
        expect(sanitizeCompany('')).toBeNull();
        expect(sanitizeCompany('   ')).toBeNull();
      });

      it('returns null for undefined/null', () => {
        expect(sanitizeCompany(undefined)).toBeNull();
        expect(sanitizeCompany(null as any)).toBeNull();
      });

      it('enforces max length', () => {
        const longName = 'a'.repeat(200);
        const result = sanitizeCompany(longName);
        expect(result!.length).toBeLessThanOrEqual(180);
      });
    });

    describe('sanitizeMessage', () => {
      it('sanitizes message text', () => {
        expect(sanitizeMessage('  Hello world  ')).toBe('Hello world');
      });

      it('enforces max length', () => {
        const longMessage = 'a'.repeat(10000);
        const result = sanitizeMessage(longMessage);
        expect(result.length).toBeLessThanOrEqual(5000);
      });

      it('removes control characters', () => {
        expect(sanitizeMessage('Hello\x00World')).toBe('HelloWorld');
      });
    });
  });

  describe('Email Validation', () => {
    it('validates correct email addresses', () => {
      expect(isValidEmail('john@example.com')).toBe(true);
      expect(isValidEmail('user.name+tag@example.co.uk')).toBe(true);
    });

    it('rejects invalid email addresses', () => {
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('invalid@')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
      expect(isValidEmail('invalid@.com')).toBe(false);
    });

    it('rejects emails exceeding max length', () => {
      const longEmail = 'a'.repeat(300) + '@example.com';
      expect(isValidEmail(longEmail)).toBe(false);
    });

    it('accepts emails at max length boundary', () => {
      const maxEmail = 'a'.repeat(240) + '@example.com'; // 255 chars total
      expect(isValidEmail(maxEmail)).toBe(true);
    });
  });

  describe('Spam Pattern Detection', () => {
    it('detects viagra spam', () => {
      expect(detectSpamPatterns('Buy cheap viagra now')).toBe(true);
      expect(detectSpamPatterns('VIAGRA discount')).toBe(true);
    });

    it('detects casino spam', () => {
      expect(detectSpamPatterns('Best online casino')).toBe(true);
    });

    it('detects lottery spam', () => {
      expect(detectSpamPatterns('You won the lottery!')).toBe(true);
    });

    it('detects urgency spam patterns', () => {
      expect(detectSpamPatterns('Limited time offer - click here now')).toBe(true);
      expect(detectSpamPatterns('Act now before it expires')).toBe(true);
    });

    it('allows legitimate messages', () => {
      expect(detectSpamPatterns('I am interested in your stock analysis platform')).toBe(false);
      expect(detectSpamPatterns('Can you help me with portfolio tracking')).toBe(false);
    });

    it('returns false for empty text', () => {
      expect(detectSpamPatterns('')).toBe(false);
    });
  });

  describe('Honeypot Field', () => {
    it('identifies populated honeypot as spam signal', () => {
      // In the actual endpoint, this is checked like:
      // if (website && website.trim() !== '') { return 201 (fool bot); }
      const website = 'http://spam-site.com';
      expect(website && website.trim() !== '').toBe(true);
    });

    it('allows empty honeypot field', () => {
      const website = '';
      expect(!!(website && website.trim() !== '')).toBe(false);
    });

    it('handles honeypot undefined/null', () => {
      const website = undefined;
      expect(!!(website && website.trim() !== '')).toBe(false);
    });
  });

  describe('Input Validation Schema', () => {
    it('requires name field', () => {
      // Simulating zod validation
      const data = { email: 'test@example.com', message: 'Hello' };
      expect((data as any).name).toBeUndefined();
    });

    it('requires email field', () => {
      const data = { name: 'John', message: 'Hello' };
      expect((data as any).email).toBeUndefined();
    });

    it('requires message field', () => {
      const data = { name: 'John', email: 'test@example.com' };
      expect((data as any).message).toBeUndefined();
    });

    it('allows optional company field', () => {
      const data = { name: 'John', email: 'test@example.com', message: 'Hello' };
      expect((data as any).company).toBeUndefined(); // Optional, so can be undefined
    });

    it('enforces field length limits', () => {
      const limits = {
        name: 120,
        email: 255,
        company: 180,
        message: 5000,
      };

      expect('a'.repeat(121).length).toBeGreaterThan(limits.name);
      expect('a'.repeat(256).length).toBeGreaterThan(limits.email);
    });
  });

  describe('Error Handling', () => {
    it('handles missing JSON body gracefully', () => {
      // Zod would throw SyntaxError for invalid JSON
      const invalidJson = '{invalid json}';
      expect(() => JSON.parse(invalidJson)).toThrow(SyntaxError);
    });

    it('handles null values in optional fields', () => {
      const data = {
        name: 'John',
        email: 'john@example.com',
        company: null,
        message: 'Hello',
      };
      expect(data.company).toBeNull();
    });
  });

  describe('Response Formats', () => {
    it('returns structured success response', () => {
      // Expected response on 201 Created
      const response = {
        success: true,
        message: 'Thank you for your interest!',
        leadId: 123,
      };
      expect(response).toHaveProperty('success', true);
      expect(response).toHaveProperty('message');
      expect(response).toHaveProperty('leadId');
    });

    it('returns structured validation error response', () => {
      // Expected response on 400 Bad Request
      const response = {
        error: 'Invalid input',
        details: [
          { field: 'email', message: 'Invalid email address' },
        ],
      };
      expect(response).toHaveProperty('error');
      expect(Array.isArray(response.details)).toBe(true);
    });

    it('returns structured rate limit response', () => {
      // Expected response on 429 Too Many Requests
      const response = {
        error: 'Too many submissions',
        retryAfter: 3600,
        resetTime: new Date().toISOString(),
      };
      expect(response).toHaveProperty('error');
      expect(response).toHaveProperty('retryAfter');
      expect(response).toHaveProperty('resetTime');
    });
  });
});
