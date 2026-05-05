import { isPreviewModeEnabled } from '../preview';
import { checkPreviewModeAPI } from '../preview-api';
import { NextResponse } from 'next/server';

describe('Preview Mode Integration', () => {
  const originalEnv = process.env.PREVIEW;

  afterEach(() => {
    process.env.PREVIEW = originalEnv;
  });

  describe('isPreviewModeEnabled', () => {
    it('returns true when PREVIEW=true', () => {
      process.env.PREVIEW = 'true';
      expect(isPreviewModeEnabled()).toBe(true);
    });

    it('returns false when PREVIEW=false', () => {
      process.env.PREVIEW = 'false';
      expect(isPreviewModeEnabled()).toBe(false);
    });

    it('returns false when PREVIEW is undefined', () => {
      delete process.env.PREVIEW;
      expect(isPreviewModeEnabled()).toBe(false);
    });
  });

  describe('checkPreviewModeAPI', () => {
    it('returns null when preview mode is disabled', () => {
      process.env.PREVIEW = 'false';
      const result = checkPreviewModeAPI('/api/user/profile');
      expect(result).toBeNull();
    });

    it('returns null when preview mode is enabled but path is /api/preview/contact', () => {
      process.env.PREVIEW = 'true';
      const result = checkPreviewModeAPI('/api/preview/contact');
      expect(result).toBeNull();
    });

    it('returns null when preview mode is enabled but path is /api/auth', () => {
      process.env.PREVIEW = 'true';
      const result = checkPreviewModeAPI('/api/auth');
      expect(result).toBeNull();
    });

    it('returns 503 response when preview mode is enabled for blocked API', () => {
      process.env.PREVIEW = 'true';
      const result = checkPreviewModeAPI('/api/user/profile');
      expect(result).not.toBeNull();
      expect(result?.status).toBe(503);
    });

    it('returns JSON error message when blocking API', async () => {
      process.env.PREVIEW = 'true';
      const result = checkPreviewModeAPI('/api/dashboard/route');
      if (result) {
        const json = await result.json();
        expect(json.error).toBe('Preview mode active');
      }
    });

    it('blocks all dashboard APIs in preview mode', () => {
      process.env.PREVIEW = 'true';
      const blocked = [
        '/api/dashboard/recommendations',
        '/api/dashboard/deepmoney-picks',
        '/api/market/indices',
        '/api/stock_data/AAPL/data',
      ];

      blocked.forEach(path => {
        const result = checkPreviewModeAPI(path);
        expect(result).not.toBeNull();
        expect(result?.status).toBe(503);
      });
    });
  });

  describe('Allowed preview APIs', () => {
    beforeEach(() => {
      process.env.PREVIEW = 'true';
    });

    it('allows /api/preview/contact', () => {
      const result = checkPreviewModeAPI('/api/preview/contact');
      expect(result).toBeNull();
    });

    it('allows /api/auth routes', () => {
      const result = checkPreviewModeAPI('/api/auth/[...nextauth]');
      expect(result).toBeNull();
    });

    it('allows /api/auth/register', () => {
      const result = checkPreviewModeAPI('/api/auth/register');
      expect(result).toBeNull();
    });
  });
});
