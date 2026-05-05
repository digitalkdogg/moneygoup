import { isPreviewModeEnabled } from '../preview';

describe('isPreviewModeEnabled', () => {
  const originalEnv = process.env.PREVIEW;

  afterEach(() => {
    process.env.PREVIEW = originalEnv;
  });

  it('returns true when PREVIEW is "true"', () => {
    process.env.PREVIEW = 'true';
    expect(isPreviewModeEnabled()).toBe(true);
  });

  it('returns true when PREVIEW is "TRUE" (uppercase)', () => {
    process.env.PREVIEW = 'TRUE';
    expect(isPreviewModeEnabled()).toBe(true);
  });

  it('returns true when PREVIEW is "True" (mixed case)', () => {
    process.env.PREVIEW = 'True';
    expect(isPreviewModeEnabled()).toBe(true);
  });

  it('returns false when PREVIEW is "false"', () => {
    process.env.PREVIEW = 'false';
    expect(isPreviewModeEnabled()).toBe(false);
  });

  it('returns false when PREVIEW is an empty string', () => {
    process.env.PREVIEW = '';
    expect(isPreviewModeEnabled()).toBe(false);
  });

  it('returns false when PREVIEW is undefined', () => {
    delete process.env.PREVIEW;
    expect(isPreviewModeEnabled()).toBe(false);
  });

  it('returns false when PREVIEW is any other string value', () => {
    process.env.PREVIEW = 'maybe';
    expect(isPreviewModeEnabled()).toBe(false);

    process.env.PREVIEW = '1';
    expect(isPreviewModeEnabled()).toBe(false);

    process.env.PREVIEW = 'yes';
    expect(isPreviewModeEnabled()).toBe(false);
  });
});
