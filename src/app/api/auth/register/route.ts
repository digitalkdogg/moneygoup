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

const logger = createLogger('api/auth/register');

// Define schema for input validation
const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters long').max(50, 'Username cannot exceed 50 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters long').max(100, 'Password cannot exceed 100 characters'),
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
    const { username, password } = registerSchema.parse(body);

    // Check if user already exists
    const [existingUsers] = await executeRawQuery('SELECT id FROM users WHERE username = ?', [username]);
    if (Array.isArray(existingUsers) && existingUsers.length > 0) {
      logger.warn('Registration attempt with existing username:', { username });
      return createErrorResponse(null, 'Username already exists', { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 10); // Hash password with salt rounds = 10

    const [result] = await executeRawQuery('INSERT INTO users (username, password_hash, approval_status) VALUES (?, ?, ?)', [username, hashedPassword, 'pending']);

    // Check if result is an array and if insertId exists
    const resultHeader = result as mysql.ResultSetHeader;
    const insertId = resultHeader.insertId;

    if (insertId === undefined || insertId === null) {
        logger.error('Failed to retrieve insertId after user registration.', { username });
        throw new Error('Failed to create user.');
    }

    logger.info('User registered successfully:', { userId: insertId, username, approvalStatus: 'pending' });
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
