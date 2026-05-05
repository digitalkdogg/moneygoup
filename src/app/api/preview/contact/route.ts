import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { z } from 'zod';
import mysql from 'mysql2/promise';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/preview/contact');

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120, 'Name cannot exceed 120 characters'),
  email: z.string().email('Invalid email address').max(255, 'Email cannot exceed 255 characters'),
  company: z.string().max(180, 'Company cannot exceed 180 characters').optional(),
  message: z.string().min(1, 'Message is required').max(5000, 'Message cannot exceed 5000 characters'),
});

export async function POST(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }

  try {
    const body = await request.json();
    const { name, email, company, message } = contactSchema.parse(body);

    const userAgent = request.headers.get('user-agent') || null;
    const ipAddress = request.headers.get('x-forwarded-for') ||
                     request.headers.get('x-real-ip') ||
                     'unknown';

    const [result] = await executeRawQuery(
      'INSERT INTO preview_leads (name, email, company, message, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [name, email, company || null, message, ipAddress, userAgent]
    );

    const resultHeader = result as mysql.ResultSetHeader;
    const insertId = resultHeader.insertId;

    if (insertId === undefined || insertId === null) {
      logger.error('Failed to retrieve insertId after saving preview lead', { email, name });
      throw new Error('Failed to save preview lead');
    }

    logger.info('Preview lead saved successfully', { leadId: insertId, email, name });

    return NextResponse.json({
      message: 'Thank you for your interest!',
      leadId: insertId,
    }, { status: 201 });

  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Validation error in preview contact', { issues: error.issues });
      return createErrorResponse(error.issues, 'Validation error', { status: 400 });
    }
    logger.error('Error saving preview lead', { error: error instanceof Error ? error : String(error) });
    return createErrorResponse(error, 'Failed to save preview lead', { status: 500 });
  }
}
