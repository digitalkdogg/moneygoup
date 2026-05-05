import { NextRequest, NextResponse } from 'next/server';
import { checkPreviewModeAPI } from './preview-api';

/**
 * Higher-order function to wrap API route handlers with preview mode blocking.
 *
 * Usage in API routes:
 * export async function GET(request: NextRequest) {
 *   return withPreviewModeCheck(request, async () => {
 *     // Your handler logic here
 *     return NextResponse.json({ data: 'example' });
 *   });
 * }
 */
export async function withPreviewModeCheck(
  request: NextRequest,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const blockResponse = checkPreviewModeAPI(pathname);

  if (blockResponse) {
    return blockResponse;
  }

  return handler();
}
