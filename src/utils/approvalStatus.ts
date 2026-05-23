import { executeRawQuery } from './databaseHelper';
import { ApprovalStatus, APPROVAL_ERROR_CODES } from '@/types/auth';

/**
 * Centralized approval gate contract for the pilot launch.
 * Maps approval_status to allow/deny outcomes.
 */

export type ApprovalGateOutcome = 
  | { allowed: true }
  | { allowed: false; code: 'ACCOUNT_PENDING_APPROVAL'; message: string }
  | { allowed: false; code: 'ACCOUNT_REJECTED'; message: string; reason?: string };

/**
 * Evaluates the approval status and returns a structured outcome.
 */
export function evaluateApprovalStatus(status: string | null | undefined, rejectedReason?: string): ApprovalGateOutcome {
  const normalizedStatus = (status?.toLowerCase() || 'pending') as ApprovalStatus;

  switch (normalizedStatus) {
    case 'approved':
      return { allowed: true };
    case 'rejected':
      return {
        allowed: false,
        code: APPROVAL_ERROR_CODES.REJECTED,
        message: 'Your account request was rejected. Contact support/admin.',
        reason: rejectedReason
      };
    case 'unsubscribed':
      return {
        allowed: false,
        code: APPROVAL_ERROR_CODES.REJECTED,
        message: 'Your account has been deactivated. Contact support to reactivate.',
      };
    case 'pending':
    default:
      return { 
        allowed: false, 
        code: APPROVAL_ERROR_CODES.PENDING, 
        message: 'Your account is awaiting admin approval.' 
      };
  }
}

/**
 * Guard function for API routes to ensure user is still approved.
 * Re-queries the database to handle stale sessions.
 */
export async function checkApprovalGuard(userId: string | number): Promise<ApprovalGateOutcome> {
  try {
    const [rows] = await executeRawQuery(
      'SELECT approval_status, rejected_reason FROM users WHERE id = ?',
      [userId]
    );

    const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    if (!user) {
      return { 
        allowed: false, 
        code: APPROVAL_ERROR_CODES.REJECTED, 
        message: 'Account not found.' 
      };
    }

    return evaluateApprovalStatus(user.approval_status, user.rejected_reason);
  } catch (error) {
    console.error('Error in checkApprovalGuard:', error);
    // On DB error, we fail closed (deny) to be safe
    return { 
      allowed: false, 
      code: APPROVAL_ERROR_CODES.PENDING, 
      message: 'Error verifying account status.' 
    };
  }
}
