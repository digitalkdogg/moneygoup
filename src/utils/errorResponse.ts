// src/utils/errorResponse.ts
//
// ── Error Handling Conventions ──────────────────────────────────────────────────
//
// This module defines a standardized approach to error handling in API routes.
// Adhering to these patterns ensures consistent API responses and robust logging.
//
// 1.  **Expected Client Errors (4xx status codes):**
//     For client-side issues like invalid input, missing authentication, or
//     resource not found, use `NextResponse.json()` directly or one of the
//     provided convenience wrappers (e.g., `unauthorizedResponse()`,
//     `notFoundResponse()`, `validationErrorResponse()`).
//     -   **NEVER** use `new NextResponse(JSON.stringify(...))` for client errors,
//         as it does not reliably set the `Content-Type: application/json` header,
//         which can cause issues for client-side parsing.
//
// 2.  **Unexpected Server Errors (5xx status codes):**
//     For any unforeseen server-side issues, always use `createErrorResponse()`.
//     This function automatically logs the full error server-side (including stack traces)
//     and returns a standardized JSON response to the client that includes a
//     `correlationId` for easier debugging without exposing sensitive server details.
//
// 3.  **Empty Results (not an error):**
//     If a query legitimately returns no data, but this is not an error condition
//     (e.g., an empty list of items), return `NextResponse.json([], { status: 200 })`.
//     -   **NEVER** use `try...catch` blocks to swallow errors and return empty arrays
//         or objects, as this hides critical server-side issues.
//
// ────────────────────────────────────────────────────────────────────────────────
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createLogger } from './logger'; // Import createLogger to get a logger instance

const logger = createLogger('errorResponse'); // Create a logger instance for this module

interface ErrorResponseOptions {
  /** HTTP status code (default: 500) */
  status?: number;
  /** Additional context to include in server-side logs only */
  context?: Record<string, unknown>;
}

export function createErrorResponse(
  error: unknown,
  message: string,
  options: ErrorResponseOptions = {}
): NextResponse {
  const { status = 500, context } = options;
  const correlationId = randomUUID();

  // ✅ Always log the full error server-side — never send it to the client
  logger.error(message, {
    correlationId,
    status,
    error, // Pass the original error; the logger's serializeError will handle it
    ...context,
  });

  // ✅ Client only receives the human-readable message and a reference ID
  // The correlationId lets developers find the full error in server logs
  return NextResponse.json(
    { message, correlationId },
    { status }
  );
}

// ── Convenience wrappers ─────────────────────────────────────────────────

export function unauthorizedResponse(message = 'Unauthorized') {
  return NextResponse.json({ message }, { status: 401 });
}

export function notFoundResponse(message = 'Not found') {
  return NextResponse.json({ message }, { status: 404 });
}

export function validationErrorResponse(message: string) {
  return NextResponse.json({ message }, { status: 400 });
}

export function forbiddenResponse(message = 'Forbidden') {
  return NextResponse.json({ message }, { status: 403 });
}
