import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';
import mysql from 'mysql2/promise'; // Import mysql types

const logger = createLogger('api/auth/register');

// Define schema for input validation
const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters long').max(50, 'Username cannot exceed 50 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters long').max(100, 'Password cannot exceed 100 characters'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password } = registerSchema.parse(body);

    // Check if user already exists
    const [existingUsers] = await executeRawQuery('SELECT id FROM users WHERE username = ?', [username]);
    if (Array.isArray(existingUsers) && existingUsers.length > 0) {
      logger.warn('Registration attempt with existing username:', { username });
      return createErrorResponse('Username already exists', 409);
    }

    const hashedPassword = await bcrypt.hash(password, 10); // Hash password with salt rounds = 10

    const [result] = await executeRawQuery('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hashedPassword]);

    // Check if result is an array and if insertId exists
    const resultHeader = result as mysql.ResultSetHeader;
    const insertId = resultHeader.insertId;

    if (insertId === undefined || insertId === null) {
        logger.error('Failed to retrieve insertId after user registration.', undefined, { username });
        throw new Error('Failed to create user.');
    }

    logger.info('User registered successfully:', { userId: insertId, username });
    return NextResponse.json({ message: 'User registered successfully', userId: insertId }, { status: 201 });

  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Validation error during registration:', { issues: error.issues });
      return createErrorResponse(error.issues, 400);
    }
    logger.error('Error during user registration:', error instanceof Error ? error : String(error));
    return createErrorResponse('Failed to register user', 500);
  }
}
