// src/utils/originCheck.ts
import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse, unauthorizedResponse, forbiddenResponse } from '@/utils/errorResponse';

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

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
  const requestReferer = request.headers.get('referer');
  const method = request.method.toUpperCase();

  // Safari in Private Browsing / iCloud Private Relay sends Origin: null.
  // Treat it the same as a missing Origin and fall through to Referer validation.
  const effectiveOrigin = requestOrigin === 'null' ? null : requestOrigin;

  // 1. Validate Origin header if present
  if (effectiveOrigin && !allowedOrigins.has(effectiveOrigin)) {
    return unauthorizedResponse('Unauthorized origin');
  }

  // 2. Stricter validation for mutating methods (CSRF protection)
  if (MUTATING_METHODS.includes(method)) {
    // If Origin is missing, fallback to Referer validation
    if (!effectiveOrigin) {
      if (!requestReferer) {
        // Both Origin and Referer are missing for a mutating request
        return forbiddenResponse('Missing Origin/Referer for mutating request');
      }

      try {
        const refererUrl = new URL(requestReferer);
        const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`;
        if (!allowedOrigins.has(refererOrigin)) {
          return unauthorizedResponse('Unauthorized referer origin');
        }
      } catch (e) {
        return forbiddenResponse('Invalid Referer header');
      }
    }
  }

  return null; // Origin/Referer is allowed
}
