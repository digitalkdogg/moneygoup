import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';
import mysql from 'mysql2/promise';
import { checkOrigin } from '@/utils/originCheck';
import { checkRateLimitPreview } from '@/utils/previewRateLimiter';
import {
  sanitizeName,
  sanitizeEmail,
  sanitizeCompany,
  sanitizeMessage,
  isValidEmail,
  detectSpamPatterns,
} from '@/utils/sanitizeInput';

const logger = createLogger('api/preview/contact');

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120, 'Name cannot exceed 120 characters'),
  email: z.string().email('Invalid email address').max(255, 'Email cannot exceed 255 characters'),
  company: z.string().max(180, 'Company cannot exceed 180 characters').optional().nullable(),
  message: z.string().min(1, 'Message is required').max(5000, 'Message cannot exceed 5000 characters'),
  website: z.string().optional().nullable(), // Honeypot field
});

export async function POST(request: NextRequest) {
  // Check origin
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  // Get IP address for rate limiting
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
                   request.headers.get('x-real-ip') ||
                   'unknown';

  // Check rate limit
  const rateLimitResult = checkRateLimitPreview(ipAddress);
  if (!rateLimitResult.allowed) {
    const resetDate = new Date(rateLimitResult.resetTime);
    logger.warn('Rate limit exceeded for preview contact', { ip: ipAddress });
    return NextResponse.json(
      {
        error: 'Too many submissions. Please try again later.',
        retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000),
        resetTime: resetDate.toISOString(),
      },
      {
        status: 429,
        headers: {
          'Retry-After': Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000).toString(),
        },
      }
    );
  }

  try {
    const body = await request.json();

    // Validate against schema (basic validation)
    const validatedData = contactSchema.parse(body);

    // Honeypot check: reject if website field is populated
    if (validatedData.website && validatedData.website.trim() !== '') {
      logger.warn('Honeypot field populated', { ip: ipAddress });
      // Return 201 to fool bots but don't save
      return NextResponse.json(
        { message: 'Thank you for your interest!' },
        { status: 201 }
      );
    }

    // Sanitize inputs
    const sanitizedName = sanitizeName(validatedData.name);
    const sanitizedEmail = sanitizeEmail(validatedData.email);
    const sanitizedCompany = sanitizeCompany(validatedData.company);
    const sanitizedMessage = sanitizeMessage(validatedData.message);

    // Validate sanitized inputs
    if (!sanitizedName || sanitizedName.length === 0) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    if (!isValidEmail(sanitizedEmail)) {
      logger.warn('Invalid email format', { email: validatedData.email });
      return NextResponse.json(
        { error: 'Invalid email address' },
        { status: 400 }
      );
    }

    if (!sanitizedMessage || sanitizedMessage.length === 0) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    // Detect spam patterns
    if (detectSpamPatterns(sanitizedName) || detectSpamPatterns(sanitizedMessage)) {
      logger.warn('Spam patterns detected', { ip: ipAddress, email: sanitizedEmail });
      // Return 201 to fool bots but don't save
      return NextResponse.json(
        { message: 'Thank you for your interest!' },
        { status: 201 }
      );
    }

    // Get user agent
    const userAgent = request.headers.get('user-agent') || null;

    // Insert into database
    const [result] = await executeRawQuery(
      'INSERT INTO preview_leads (name, email, company, message, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [sanitizedName, sanitizedEmail, sanitizedCompany, sanitizedMessage, ipAddress, userAgent]
    );

    const resultHeader = result as mysql.ResultSetHeader;
    const insertId = resultHeader.insertId;

    if (insertId === undefined || insertId === null) {
      logger.error('Failed to retrieve insertId after saving preview lead', {
        email: sanitizedEmail,
        name: sanitizedName,
      });
      throw new Error('Failed to save preview lead');
    }

    logger.info('Preview lead saved successfully', {
      leadId: insertId,
      email: sanitizedEmail,
      name: sanitizedName,
      ip: ipAddress,
    });

    // TODO: Send email notification here
    // Example:
    // await sendEmailNotification({
    //   leadId: insertId,
    //   name: sanitizedName,
    //   email: sanitizedEmail,
    //   company: sanitizedCompany,
    //   message: sanitizedMessage,
    // });

    return NextResponse.json(
      {
        success: true,
        message: 'Thank you for your interest! We will review your submission shortly.',
        leadId: insertId,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Validation error in preview contact', {
        issues: error.issues,
        ip: ipAddress,
      });
      return NextResponse.json(
        {
          error: 'Invalid input',
          details: error.issues.map(e => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 }
      );
    }

    if (error instanceof SyntaxError) {
      logger.warn('Invalid JSON in preview contact request', { ip: ipAddress });
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    logger.error('Error saving preview lead', {
      error: error instanceof Error ? error.message : String(error),
      ip: ipAddress,
    });

    return NextResponse.json(
      { error: 'Failed to process your submission. Please try again later.' },
      { status: 500 }
    );
  }
}
