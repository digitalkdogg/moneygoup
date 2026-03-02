import Cache from '../cache';

describe('Cache', () => {
  let cache: Cache<string>;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new Cache<string>(1000); // 1 second TTL
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  test('sets and gets values', () => {
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  test('returns null for missing keys', () => {
    expect(cache.get('missing')).toBeNull();
  });

  test('expires values after TTL', () => {
    cache.set('key1', 'value1', 500); // 0.5s TTL
    jest.advanceTimersByTime(501);
    expect(cache.get('key1')).toBeNull();
  });

  test('respects custom TTL', () => {
    cache.set('key1', 'value1', 2000); // 2s TTL
    jest.advanceTimersByTime(1500);
    expect(cache.get('key1')).toBe('value1');
    jest.advanceTimersByTime(501);
    expect(cache.get('key1')).toBeNull();
  });

  test('has() checks for existence and expiration', () => {
    cache.set('key1', 'value1', 500);
    expect(cache.has('key1')).toBe(true);
    jest.advanceTimersByTime(501);
    expect(cache.has('key1')).toBe(false);
  });

  test('delete() removes keys', () => {
    cache.set('key1', 'value1');
    cache.delete('key1');
    expect(cache.has('key1')).toBe(false);
  });

  test('clear() removes all keys', () => {
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  test('cleanup() removes expired entries', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    cache.set('key1', 'value1', 100);
    cache.set('key2', 'value2', 10 * 60 * 1000); // 10 minutes TTL
    
    jest.advanceTimersByTime(200);
    // Advance enough for key1 to be expired AND for cleanup to run (5 mins)
    jest.advanceTimersByTime(5 * 60 * 1000);
    
    expect(cache.has('key1')).toBe(false);
    expect(cache.has('key2')).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cache cleanup'));
    consoleSpy.mockRestore();
  });
});
