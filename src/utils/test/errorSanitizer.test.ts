import {
  sanitizeErrorForClient,
  extractCorrelationId,
  sanitizeErrorForLogging,
  SafeError
} from '../errorSanitizer';

describe('errorSanitizer', () => {
  describe('sanitizeErrorForClient', () => {
    test('allows safe error messages', () => {
      const error = new Error('Resource not found');
      expect(sanitizeErrorForClient(error)).toBe('Resource not found');
    });

    test('replaces unsafe error messages with generic one', () => {
      const error = new Error('ECONNREFUSED 127.0.0.1:3306');
      expect(sanitizeErrorForClient(error)).toBe('An unexpected error occurred. Please try again later.');
    });

    test('hides database error patterns', () => {
      const error = new Error('ER_ACCESS_DENIED_ERROR: Access denied for user...');
      expect(sanitizeErrorForClient(error)).toBe('An unexpected error occurred. Please try again later.');
    });

    test('hides file path patterns', () => {
      const error = new Error('Error at /var/www/html/file.ts');
      expect(sanitizeErrorForClient(error)).toBe('An unexpected error occurred. Please try again later.');
    });

    test('handles non-Error objects', () => {
      expect(sanitizeErrorForClient('string error')).toBe('An unexpected error occurred. Please try again later.');
    });
  });

  describe('extractCorrelationId', () => {
    test('extracts correlationId from context', () => {
      const context = { correlationId: 'abc-123', other: 'data' };
      expect(extractCorrelationId(context)).toBe('abc-123');
    });

    test('returns undefined if no correlationId', () => {
      expect(extractCorrelationId({ other: 'data' })).toBeUndefined();
      expect(extractCorrelationId(undefined)).toBeUndefined();
    });
  });

  describe('sanitizeErrorForLogging', () => {
    test('extracts error details for logging', () => {
      const error = new Error('Log message');
      error.name = 'TestError';
      const sanitized = sanitizeErrorForLogging(error);
      expect(sanitized.name).toBe('TestError');
      expect(sanitized.message).toBe('Log message');
      expect(sanitized.stack).toBeDefined();
    });

    test('handles non-Error objects for logging', () => {
      const sanitized = sanitizeErrorForLogging('string error');
      expect(sanitized.message).toBe('string error');
      expect(sanitized.type).toBe('string');
    });
  });

  describe('SafeError', () => {
    test('creates an error with status and context', () => {
      const context = { userId: 123 };
      const error = new SafeError('Internal msg', 400, 'User msg', context);
      expect(error.message).toBe('Internal msg');
      expect(error.statusCode).toBe(400);
      expect(error.userMessage).toBe('User msg');
      expect(error.context).toBe(context);
    });
  });
});
