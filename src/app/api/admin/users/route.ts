import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery, update } from '@/utils/databaseHelper';
import { unauthorizedResponse, forbiddenResponse, createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { sendApprovalEmail } from '@/lib/email';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/admin/users');

/**
 * GET: List all users for admin console.
 */
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);

  if (!session || !session.user) {
    return unauthorizedResponse();
  }

  const userRole = (session.user as any).role;
  if (userRole !== 'admin') {
    return forbiddenResponse('Admin access required');
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status'); // pending, approved, rejected
  const role = searchParams.get('role'); // user, superuser, admin
  const search = searchParams.get('search');

  try {
    let query = 'SELECT id, username, email, role, approval_status, created_at, last_login, rejected_reason FROM users WHERE 1=1';
    const params: any[] = [];

    if (status) {
      query += ' AND approval_status = ?';
      params.push(status);
    }

    if (role) {
      query += ' AND role = ?';
      params.push(role);
    }

    if (search) {
      query += ' AND username LIKE ?';
      params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC';

    const [users] = await executeRawQuery(query, params);

    return NextResponse.json({ users });
  } catch (error) {
    logger.error('Failed to fetch users for admin', { error });
    return createErrorResponse(error, 'Failed to fetch users');
  }
}

/**
 * PATCH: Update user status (approve/reject) or role.
 */
export async function PATCH(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);

  if (!session || !session.user) {
    return unauthorizedResponse();
  }

  const adminUser = session.user as any;
  if (adminUser.role !== 'admin') {
    return forbiddenResponse('Admin access required');
  }

  try {
    const body = await request.json();
    const { userId, approval_status, rejected_reason, role } = body;

    if (!userId) {
      return NextResponse.json({ message: 'User ID is required' }, { status: 400 });
    }

    const updates: any = {};
    if (approval_status) {
      updates.approval_status = approval_status;
      if (approval_status === 'approved') {
        updates.approved_by = adminUser.id;
        updates.approved_at = new Date();
        updates.rejected_reason = null;
      } else if (approval_status === 'rejected') {
        updates.rejected_reason = rejected_reason || 'No reason provided';
        updates.approved_by = adminUser.id; // Still track who rejected
      }
    }

    if (role) {
      // Safety: Prevent demoting the last admin (simplified check)
      if (role !== 'admin') {
        const [admins]: any = await executeRawQuery('SELECT COUNT(*) as count FROM users WHERE role = "admin"', []);
        if (admins[0].count <= 1) {
          // Check if the user being updated IS the admin
          const [targetUser]: any = await executeRawQuery('SELECT role FROM users WHERE id = ?', [userId]);
          if (targetUser[0]?.role === 'admin') {
            return NextResponse.json({ message: 'Cannot demote the only admin' }, { status: 400 });
          }
        }
      }
      updates.role = role;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ message: 'No updates provided' }, { status: 400 });
    }

    await update('users', updates, { id: userId });

    logger.info('Admin updated user', { adminId: adminUser.id, targetUserId: userId, updates });

    if (approval_status === 'approved') {
      const [rows]: any = await executeRawQuery(
        'SELECT email, username FROM users WHERE id = ?',
        [userId]
      );
      const user = rows[0];
      if (user?.email) {
        try {
          await sendApprovalEmail(user.email, user.username);
        } catch (emailErr) {
          logger.error('Failed to send approval email', { emailErr, targetUserId: userId });
        }
      }
    }

    return NextResponse.json({ message: 'User updated successfully' });
  } catch (error) {
    logger.error('Failed to update user', { error });
    return createErrorResponse(error, 'Failed to update user');
  }
}
