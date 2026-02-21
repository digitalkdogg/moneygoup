// src/utils/errorResponse.ts
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
    error: error instanceof Error
      ? { message: error.message, stack: error.stack, name: error.name }
      : String(error),
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
