/**
 * Shared authentication types and constants.
 * This file is safe to import in both client and server components.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type UserRole = 'user' | 'superuser' | 'admin';

export const APPROVAL_ERROR_CODES = {
  PENDING: 'ACCOUNT_PENDING_APPROVAL',
  REJECTED: 'ACCOUNT_REJECTED',
} as const;

export type ApprovalErrorCode = typeof APPROVAL_ERROR_CODES[keyof typeof APPROVAL_ERROR_CODES];
