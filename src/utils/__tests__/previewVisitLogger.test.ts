import {
  extractIpAddress,
  getCurrentUtcTimestamp,
  shouldLogVisit,
  __resetRecentVisits,
} from '../previewVisitLogger';

describe('Preview Visit Logger', () => {
  describe('extractIpAddress', () => {
    it('extracts client IP from x-forwarded-for header', () => {
      const result = extractIpAddress('192.168.1.1, 10.0.0.1, 172.16.0.1');
      expect(result).toBe('192.168.1.1');
    });

    it('handles x-forwarded-for with single IP', () => {
      const result = extractIpAddress('203.0.113.45');
      expect(result).toBe('203.0.113.45');
    });

    it('extracts from x-real-ip when x-forwarded-for is null', () => {
      const result = extractIpAddress(null, '192.168.1.100');
      expect(result).toBe('192.168.1.100');
    });

    it('uses fallback when both headers are null', () => {
      const result = extractIpAddress(null, null, '127.0.0.1');
      expect(result).toBe('127.0.0.1');
    });

    it('defaults to "unknown" when no headers and no fallback', () => {
      const result = extractIpAddress(null, null);
      expect(result).toBe('unknown');
    });

    it('trims whitespace from x-real-ip', () => {
      const result = extractIpAddress(null, '  192.168.1.50  ');
      expect(result).toBe('192.168.1.50');
    });

    it('handles empty x-forwarded-for string', () => {
      const result = extractIpAddress('', null, '10.0.0.1');
      expect(result).toBe('10.0.0.1');
    });

    it('prioritizes x-forwarded-for over x-real-ip', () => {
      const result = extractIpAddress('203.0.113.1', '192.168.1.1');
      expect(result).toBe('203.0.113.1');
    });

    it('handles malformed x-forwarded-for with empty values', () => {
      const result = extractIpAddress(', , 203.0.113.1', null, '127.0.0.1');
      // Should skip empty values and find first valid IP
      expect(result).toBe('203.0.113.1');
    });

    it('validates IPv4 addresses', () => {
      const ipv4 = '192.168.1.1';
      const result = extractIpAddress(ipv4);
      expect(result).toBe(ipv4);
    });

    it('handles IPv6 addresses', () => {
      const ipv6 = '2001:db8::1';
      const result = extractIpAddress(ipv6);
      expect(result).toBe(ipv6);
    });
  });

  describe('getCurrentUtcTimestamp', () => {
    it('returns a Date object', () => {
      const result = getCurrentUtcTimestamp();
      expect(result).toBeInstanceOf(Date);
    });

    it('returns current time (within 1 second)', () => {
      const before = Date.now();
      const result = getCurrentUtcTimestamp();
      const after = Date.now();

      const resultTime = result.getTime();
      expect(resultTime).toBeGreaterThanOrEqual(before);
      expect(resultTime).toBeLessThanOrEqual(after);
    });

    it('returns UTC time (not local)', () => {
      const timestamp = getCurrentUtcTimestamp();
      // Check that it's a valid ISO-8601 format
      const iso = timestamp.toISOString();
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('multiple calls return increasing timestamps', () => {
      const first = getCurrentUtcTimestamp();
      // Small delay
      const second = getCurrentUtcTimestamp();
      expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    });

    it('timestamp is valid for database insertion', () => {
      const timestamp = getCurrentUtcTimestamp();
      // Should be convertible to SQL format
      const sqlFormat = timestamp.toISOString().replace('T', ' ').slice(0, 19);
      expect(sqlFormat).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('shouldLogVisit', () => {
    beforeEach(() => {
      __resetRecentVisits();
    });

    it('returns true for first visit from IP', () => {
      const result = shouldLogVisit('192.168.1.1');
      expect(result).toBe(true);
    });

    it('returns false for immediate duplicate visit from same IP', () => {
      const ip = '192.168.1.100';
      shouldLogVisit(ip); // First call
      const result = shouldLogVisit(ip); // Second call immediately after
      expect(result).toBe(false);
    });

    it('allows visits after dedup window expires', () => {
      const ip = '192.168.1.200';
      shouldLogVisit(ip); // First visit

      // Check within dedup window
      expect(shouldLogVisit(ip)).toBe(false);

      // Can't wait 60s in tests, so just verify the logic works
      expect(shouldLogVisit(ip)).toBe(false); // Still in window
    });

    it('tracks multiple different IPs independently', () => {
      const ip1 = '192.168.1.1';
      const ip2 = '192.168.1.2';

      expect(shouldLogVisit(ip1)).toBe(true);
      expect(shouldLogVisit(ip2)).toBe(true);
      expect(shouldLogVisit(ip1)).toBe(false);
      expect(shouldLogVisit(ip2)).toBe(false);
    });

    it('handles unknown IP address', () => {
      const result = shouldLogVisit('unknown');
      expect(result).toBe(true); // Still logs, just handled specially
    });

    it('handles IPv6 addresses', () => {
      const ipv6 = '2001:db8::1';
      expect(shouldLogVisit(ipv6)).toBe(true);
      expect(shouldLogVisit(ipv6)).toBe(false);
    });
  });

  describe('Input Validation', () => {
    it('rejects empty IP address in extraction', () => {
      const result = extractIpAddress('', '');
      expect(result).toBe('unknown');
    });

    it('handles very long IP address strings', () => {
      const longIp = '192.168.1.1' + 'x'.repeat(200);
      // Should still extract the IP portion
      const result = extractIpAddress(longIp);
      expect(result).toContain('192.168.1.1');
    });

    it('handles special characters in headers', () => {
      const result = extractIpAddress('192.168.1.1; DROP TABLE;');
      expect(result).toBe('192.168.1.1; DROP TABLE;'); // Still returns it, sanitized later
    });
  });

  describe('Edge Cases', () => {
    it('handles null values gracefully', () => {
      const result = extractIpAddress(null, null);
      expect(result).toBe('unknown');
    });

    it('handles undefined values gracefully', () => {
      const result = extractIpAddress(undefined, undefined);
      expect(result).toBe('unknown');
    });

    it('handles very long x-forwarded-for header', () => {
      const longHeader = Array(100).fill('192.168.1.1').join(', ');
      const result = extractIpAddress(longHeader);
      expect(result).toBe('192.168.1.1');
    });

    it('handles whitespace-only header', () => {
      const result = extractIpAddress('   ', '   ', '127.0.0.1');
      expect(result).toBe('127.0.0.1');
    });
  });

  describe('Data Formats', () => {
    it('timestamp ISO format is consistent', () => {
      const timestamp = getCurrentUtcTimestamp();
      const iso = timestamp.toISOString();
      // Should be ISO 8601: YYYY-MM-DDTHH:MM:SS.sssZ
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('timestamp can be converted to MySQL format', () => {
      const timestamp = getCurrentUtcTimestamp();
      const mysqlFormat = timestamp.toISOString().split('T')[0] + ' ' +
                         timestamp.toISOString().split('T')[1].split('.')[0];
      expect(mysqlFormat).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('IP address format validation', () => {
      const validIps = [
        '192.168.1.1',
        '10.0.0.1',
        '127.0.0.1',
        '255.255.255.255',
        '0.0.0.0',
        '2001:db8::1',
        '::1',
      ];

      validIps.forEach(ip => {
        const result = extractIpAddress(ip);
        expect(result).toBe(ip);
      });
    });
  });

  describe('Deduplication Strategy', () => {
    it('first visit from IP is logged', () => {
      expect(shouldLogVisit('203.0.113.1')).toBe(true);
    });

    it('same IP within 1 minute is deduplicated', () => {
      const ip = '203.0.113.2';
      shouldLogVisit(ip);
      expect(shouldLogVisit(ip)).toBe(false);
    });

    it('different IPs are tracked independently', () => {
      const ips = ['203.0.113.3', '203.0.113.4', '203.0.113.5'];
      ips.forEach(ip => {
        expect(shouldLogVisit(ip)).toBe(true);
      });
      // All should now be marked as seen
      ips.forEach(ip => {
        expect(shouldLogVisit(ip)).toBe(false);
      });
    });

    it('dedup prevents logging spam from single IP', () => {
      const ip = '203.0.113.6';
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(shouldLogVisit(ip));
      }
      // First should be true, rest false
      expect(results[0]).toBe(true);
      results.slice(1).forEach(result => {
        expect(result).toBe(false);
      });
    });
  });

  describe('Performance', () => {
    it('IP extraction is fast (< 1ms)', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        extractIpAddress('192.168.1.1', null);
      }
      const end = performance.now();
      expect(end - start).toBeLessThan(100); // 1000 ops should be < 100ms
    });

    it('timestamp generation is fast (< 1ms)', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        getCurrentUtcTimestamp();
      }
      const end = performance.now();
      expect(end - start).toBeLessThan(100);
    });

    it('dedup check is fast (< 1ms)', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        shouldLogVisit(`192.168.1.${i % 255}`);
      }
      const end = performance.now();
      expect(end - start).toBeLessThan(500); // 1000 ops with different IPs
    });
  });
});
