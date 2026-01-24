// src/utils/errorResponse.ts
import { NextResponse } from 'next/server';

export function createErrorResponse(
  error: unknown,
  statusCode: number = 500
): NextResponse {
  let message = 'An unexpected error occurred';
  let details: string | undefined;

  if (error instanceof Error) {
    message = error.message;
    // Only include stack trace in development for security
    if (process.env.NODE_ENV === 'development') {
      details = error.stack;
    }
  } else if (typeof error === 'string') {
    message = error;
  }

  return NextResponse.json(
    {
      status: 'error',
      message,
      details,
    },
    { status: statusCode }
  );
}
