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
    const rateLimitResponse = checkRateLimit(request, registerLimiter, 'register', usernameForRateLimit);
    if (rateLimitResponse) return rateLimitResponse;

    const body = await request.json();
    const { username, email, password } = registerSchema.parse(body);

    // Check if email already exists
    const [emailCheck] = await executeRawQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (Array.isArray(emailCheck) && emailCheck.length > 0) {
      logger.warn('Registration attempt with existing email:', { email });
      return createErrorResponse(null, 'An account with this email address is already registered.', { status: 409 });
    }

    // Check if username already exists
    const [usernameCheck] = await executeRawQuery('SELECT id FROM users WHERE username = ?', [username]);
    if (Array.isArray(usernameCheck) && usernameCheck.length > 0) {
      logger.warn('Registration attempt with existing username:', { username });
      return createErrorResponse(null, 'This username is already taken.', { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 10); // Hash password with salt rounds = 10

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
