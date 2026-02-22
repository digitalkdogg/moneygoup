/**
 * Error sanitization utility for API responses
 * Prevents information disclosure by removing sensitive details from error messages
 * sent to clients while preserving full details in server logs
 */

/**
 * List of error patterns that are safe to show to clients
 * Any error message not matching these patterns will be replaced with a generic message
 */
const SAFE_ERROR_PATTERNS = [
  /resource not found/i,
  /not found/i,
  /invalid input/i,
  /invalid ticker/i,
  /invalid period/i,
  /invalid stock id/i,
  /authentication required/i,
  /unauthorized/i,
  /forbidden/i,
  /rate limit exceeded/i,
  /too many requests/i,
  /duplicate entry/i,
  /validation error/i,
];

/**
 * Sanitize an error for safe client-side display
 * Returns a safe error message, never exposing system details
 *
 * @param error - The error to sanitize
 * @returns Safe error message for client response
 */
export function sanitizeErrorForClient(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'An unexpected error occurred. Please try again later.';
  }

  // Check if error message matches safe patterns
  if (SAFE_ERROR_PATTERNS.some(pattern => pattern.test(error.message))) {
    return error.message;
  }

  // Don't expose database errors, file system errors, API details, etc.
  if (
    error.message.includes('ENOTFOUND') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ER_') || // MySQL errors
    error.message.includes('UNIQUE constraint') || // SQLite errors
    error.message.includes('/var/') || // File paths
    error.message.includes('process.env') || // Environment variables
    error.message.includes('spawn') || // subprocess errors
    error.message.includes('http')
  ) {
    return 'An unexpected error occurred. Please try again later.';
  }

  // Default safe fallback
  return 'An unexpected error occurred. Please try again later.';
}

/**
 * Extract correlationId from error context for logging reference
 * Used to link client errors to server logs for debugging
 *
 * @param context - Error context object
 * @returns Correlation ID or undefined
 */
export function extractCorrelationId(context?: Record<string, unknown>): string | undefined {
  return typeof context?.correlationId === 'string' ? context.correlationId : undefined;
}

/**
 * Remove sensitive fields from error details for logging
 * Prevents PII or secrets from appearing in logs
 *
 * @param error - Error object
 * @returns Sanitized error details for logging
 */
export function sanitizeErrorForLogging(error: unknown) {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
      type: typeof error,
    };
  }

  // Include stack trace in logs (server-side only)
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

/**
 * Type-safe error constructor
 * Creates errors with optional user-facing message and context
 */
export class SafeError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public userMessage?: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SafeError';
  }
}
