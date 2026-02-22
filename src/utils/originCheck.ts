// src/utils/originCheck.ts
import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';

export function checkOrigin(request: NextRequest): NextResponse | null {
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || process.env.NEXTAUTH_URL;

  if (!allowedOriginsString) {
    // Fail-closed: if no allowed origins are configured, deny all cross-origin requests.
    // Set ALLOWED_ORIGINS or NEXTAUTH_URL in your environment to permit specific origins.
    return createErrorResponse(
      new Error('Server misconfiguration: origin policy not configured'),
      'Server misconfiguration: origin policy not configured',
      { status: 500 }
    );
  }

  const allowedOrigins = new Set(allowedOriginsString.split(',').map(o => o.trim()));
  const requestOrigin = request.headers.get('origin');

  // Server-to-server requests (no Origin header) are allowed through.
  // Browser requests without a matching origin are rejected.
  if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
    return unauthorizedResponse('Unauthorized origin');
  }

  return null; // Origin is allowed
}
