import { NextResponse, NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse } from '@/utils/errorResponse';
import { performDeepAnalysis } from './analysis';

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request as any);
  if (originCheckResponse) return originCheckResponse;

  const apiKey = request.headers.get('x-api-key');
  const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;

  if (!apiKey || apiKey !== internalSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const analysis = await performDeepAnalysis();
    return NextResponse.json(analysis);

  } catch (error) {
    console.error('DeepMoney API Error:', error);
    return createErrorResponse(error, 'Failed to perform deep analysis.', { status: 500 });
  }
}
