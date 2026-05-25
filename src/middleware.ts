import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === 'development';
  return [
    `default-src 'self' https:`,
    // unsafe-eval is needed only in dev for Next.js Fast Refresh (react-refresh runtime)
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self' https:`,
  ].join('; ');
}

// Public paths that don't require a session but still get a nonce-based CSP
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/api/unsubscribe', '/contact'];

export default withAuth(
  function middleware(req: NextRequest) {
    const nonce = generateNonce();
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-nonce', nonce);

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set('Content-Security-Policy', buildCsp(nonce));
    return response;
  },
  {
    callbacks: {
      authorized: ({ req, token }) => {
        const pathname = req.nextUrl.pathname;

        // Public pages — allow through so the middleware function still runs (CSP gets set)
        if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '?'))) return true;

        // x-api-key bypass
        const apiKey = req.headers.get("x-api-key");
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;
        if (apiKey && internalSecret && apiKey === internalSecret) return true;

        return !!token;
      },
    },
  }
);

export const config = {
  // Exclude api/auth (NextAuth internals) and static assets; include all other routes
  // so every page — including login/register — gets the nonce-based CSP.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|growmystock_logo.svg|favicon.ico).*)",
  ],
};
