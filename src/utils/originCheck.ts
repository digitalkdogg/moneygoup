// src/utils/originCheck.ts
import { NextRequest, NextResponse } from 'next/server';

export function checkOrigin(request: NextRequest): NextResponse | null {
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || process.env.NEXTAUTH_URL;

  if (!allowedOriginsString) {
    // Fail-closed: if no allowed origins are configured, deny all cross-origin requests.
    // Set ALLOWED_ORIGINS or NEXTAUTH_URL in your environment to permit specific origins.
    console.error('[originCheck] ALLOWED_ORIGINS / NEXTAUTH_URL is not set. All cross-origin requests will be blocked.');
    return new NextResponse(JSON.stringify({ message: 'Server misconfiguration: origin policy not configured' }), { status: 500 });
  }

  const allowedOrigins = new Set(allowedOriginsString.split(',').map(o => o.trim()));
  const requestOrigin = request.headers.get('origin');

  // Server-to-server requests (no Origin header) are allowed through.
  // Browser requests without a matching origin are rejected.
  if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized origin' }), { status: 401 });
  }

  return null; // Origin is allowed
}
