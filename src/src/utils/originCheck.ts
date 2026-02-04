// src/utils/originCheck.ts
import { NextRequest, NextResponse } from 'next/server';

export function checkOrigin(request: NextRequest): NextResponse | null {
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || process.env.NEXTAUTH_URL;
  let allowedOrigins: Set<string>;

  if (allowedOriginsString) {
    allowedOrigins = new Set(allowedOriginsString.split(',').map(o => o.trim()));
  } else {
    allowedOrigins = new Set();
  }

  const requestOrigin = request.headers.get('origin');

  if (allowedOrigins.size > 0 && requestOrigin) {
    if (!allowedOrigins.has(requestOrigin)) {
      return new NextResponse(JSON.stringify({ message: 'Unauthorized origin' }), { status: 401 });
    }
  }

  return null; // Origin is allowed
}
