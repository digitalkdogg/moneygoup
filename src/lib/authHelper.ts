/**
 * Authentication helper utilities
 * Reduces code duplication across endpoints that require authentication
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { unauthorizedResponse, forbiddenResponse } from '@/utils/errorResponse';

export interface AuthSession {
  user?: {
    id?: string;
    email?: string;
    name?: string;
  };
}

/**
 * Require user authentication and return session
 * If not authenticated, returns a 401 response that should be returned immediately
 *
 * Usage:
 * const result = await requireUserSession();
 * if (result.response) return result.response;  // Return error if not authenticated
 * const { userId } = result;
 *
 * @returns Object with either { response: 401 error } or { userId, session }
 */
export async function requireUserSession(request?: NextRequest) {
  const session = await getServerSession(authOptions) as AuthSession;

  if (!session?.user?.id) {
    return {
      session: null,
      userId: null,
      response: unauthorizedResponse('Authentication required'),
    };
  }

  return {
    session,
    userId: session.user.id,
    response: null,
  };
}

/**
 * Verify user owns the requested resource
 * Prevents horizontal privilege escalation (user A viewing user B's data)
 *
 * @param requestedUserId - User ID from request params
 * @param sessionUserId - User ID from session
 * @returns Either null (allowed) or a 403 Forbidden response
 */
export function verifyOwnership(requestedUserId: string, sessionUserId: string): NextResponse | null {
  if (requestedUserId !== sessionUserId) {
    return forbiddenResponse('Cannot access another user\'s resources');
  }
  return null;
}

/**
 * Convenient wrapper for common auth + ownership check pattern
 * Combines requireUserSession and verifyOwnership
 *
 * Usage:
 * const authResult = await requireOwnership(requestedUserId);
 * if (authResult.response) return authResult.response;
 * const { userId } = authResult;
 *
 * @param requestedUserId - User ID from request params
 * @returns Object with error response or { userId }
 */
export async function requireOwnership(requestedUserId: string) {
  const { userId, response: authError } = await requireUserSession();

  if (authError) {
    return { userId: null, response: authError };
  }

  const ownershipError = verifyOwnership(requestedUserId, userId!);
  if (ownershipError) {
    return { userId, response: ownershipError };
  }

  return { userId, response: null };
}
