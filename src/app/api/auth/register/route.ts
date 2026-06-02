import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';
import mysql from 'mysql2/promise'; // Import mysql types
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimit } from '@/utils/rateLimitMiddleware';
import { registerLimiter } from '@/utils/rateLimiter';
import { sendRegistrationEmail } from '@/lib/email';

const logger = createLogger('api/auth/register');

// Define schema for input validation
const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters long').max(50, 'Username cannot exceed 50 characters'),
  email: z.string().email('Invalid email address').max(255, 'Email cannot exceed 255 characters'),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(100, 'Password cannot exceed 100 characters').regex(/\d/, 'Password must contain at least one number'),
});

export async function POST(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  try {
    // Clone request to read body for rate limiting secondary dimension
    const clonedRequest = request.clone();
    let usernameForRateLimit: string | undefined;
    
    try {
      const body = await clonedRequest.json();
      usernameForRateLimit = body.username;
    } catch (e) {
      // Body not readable or not JSON, will be handled by schema validation later
    }

    // Rate limit by IP address + username
    const rateLimitResponse = await checkRateLimit(request, registerLimiter, 'register', usernameForRateLimit);
    if (rateLimitResponse) return rateLimitResponse;

    const body = await request.json();
    const { username, email, password } = registerSchema.parse(body);

    // Check for conflicts — rejected accounts are allowed to re-register
    const [emailRows] = await executeRawQuery('SELECT id, approval_status FROM users WHERE email = ?', [email]);
    const emailConflict = Array.isArray(emailRows) && emailRows.length > 0 ? (emailRows[0] as any) : null;
    if (emailConflict && emailConflict.approval_status !== 'rejected') {
      logger.warn('Registration attempt with existing email:', { email });
      return createErrorResponse(null, 'An account with this email address is already registered.', { status: 409 });
    }

    const [usernameRows] = await executeRawQuery('SELECT id, approval_status FROM users WHERE username = ?', [username]);
    const usernameConflict = Array.isArray(usernameRows) && usernameRows.length > 0 ? (usernameRows[0] as any) : null;
    if (usernameConflict && usernameConflict.approval_status !== 'rejected') {
      logger.warn('Registration attempt with existing username:', { username });
      return createErrorResponse(null, 'This username is already taken.', { status: 409 });
    }

    // Archive any rejected records that would block the INSERT (unique key on email/username).
    // Append '_archived' to whichever field(s) conflict and set approval_status = 'archived'.
    // Use a Map keyed by id so a record that conflicts on both fields is only updated once.
    const toArchive = new Map<number, { archiveEmail: boolean; archiveUsername: boolean }>();
    if (emailConflict) {
      toArchive.set(emailConflict.id, { archiveEmail: true, archiveUsername: false });
    }
    if (usernameConflict) {
      const existing = toArchive.get(usernameConflict.id);
      if (existing) {
        existing.archiveUsername = true;
      } else {
        toArchive.set(usernameConflict.id, { archiveEmail: false, archiveUsername: true });
      }
    }
    for (const [id, { archiveEmail, archiveUsername }] of toArchive) {
      const setParts = ['approval_status = ?'];
      const params: any[] = ['archived'];
      if (archiveEmail)    { setParts.push('email = CONCAT(email, ?)');    params.push('_archived'); }
      if (archiveUsername) { setParts.push('username = CONCAT(username, ?)'); params.push('_archived'); }
      params.push(id);
      await executeRawQuery(`UPDATE users SET ${setParts.join(', ')} WHERE id = ?`, params);
      logger.info('Archived rejected user record to allow re-registration', { id, archiveEmail, archiveUsername });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await executeRawQuery('INSERT INTO users (username, email, password_hash, approval_status) VALUES (?, ?, ?, ?)', [username, email, hashedPassword, 'pending']);

    // Check if result is an array and if insertId exists
    const resultHeader = result as mysql.ResultSetHeader;
    const insertId = resultHeader.insertId;

    if (insertId === undefined || insertId === null) {
        logger.error('Failed to retrieve insertId after user registration.', { username });
        throw new Error('Failed to create user.');
    }

    logger.info('User registered successfully:', { userId: insertId, username, approvalStatus: 'pending' });

    try {
      await sendRegistrationEmail(email, username);
    } catch (emailError) {
      logger.warn('Registration email failed to send:', { userId: insertId, error: emailError instanceof Error ? emailError.message : String(emailError) });
    }

    return NextResponse.json({
      message: 'Account created and awaiting admin approval',
      userId: insertId,
      approvalStatus: 'pending'
    }, { status: 201 });

  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Validation error during registration:', { issues: error.issues });
      return createErrorResponse(error.issues, 'Validation error during registration', { status: 400 });
    }
    logger.error('Error during user registration:', { error: error instanceof Error ? error : String(error) });
    return createErrorResponse(error, 'Failed to register user', { status: 500 });
  }
}
