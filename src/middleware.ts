import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const isPreviewModeEnabled = (): boolean => {
  const previewEnv = process.env.PREVIEW;
  if (previewEnv === undefined || previewEnv === null) {
    return false;
  }
  return previewEnv.toLowerCase() === 'true';
};

const PREVIEW_BLOCKED_ROUTES = ['/', '/search', '/login'];

function handlePreviewMode(req: NextRequest): NextResponse | null {
  const isPreview = isPreviewModeEnabled();
  const pathname = req.nextUrl.pathname;

  if (!isPreview) {
    return null;
  }

  // In preview mode, redirect blocked routes to /preview
  if (PREVIEW_BLOCKED_ROUTES.includes(pathname)) {
    return NextResponse.redirect(new URL('/preview', req.url));
  }

  // In preview mode, block access to non-preview app pages
  if (!pathname.startsWith('/preview') &&
      !pathname.startsWith('/api/preview') &&
      !pathname.startsWith('/api/auth') &&
      !pathname.startsWith('/api/debug')) {
    // Allow static assets and system routes
    if (!pathname.startsWith('/_next') && !pathname.match(/\.(svg|ico|png|jpg|jpeg|gif|webp)$/)) {
      return NextResponse.redirect(new URL('/preview', req.url));
    }
  }

  return null;
}

export default withAuth(
  function middleware(req: NextRequest) {
    // Check preview mode first (before auth)
    const previewResponse = handlePreviewMode(req);
    if (previewResponse) {
      return previewResponse;
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ req, token }) => {
        const isPreview = isPreviewModeEnabled();
        const pathname = req.nextUrl.pathname;

        // Allow debug endpoints without auth
        if (pathname.startsWith('/api/debug')) {
          return true;
        }

        // Allow preview page access without auth
        if (isPreview && pathname === '/preview') {
          return true;
        }

        // Allow preview API access without auth
        if (isPreview && pathname.startsWith('/api/preview')) {
          return true;
        }

        // 1. Bypass if x-api-key is present and valid
        const apiKey = req.headers.get("x-api-key");
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;

        if (apiKey && internalSecret && apiKey === internalSecret) {
          return true;
        }

        // 2. Otherwise require a valid session token
        return !!token;
      },
    },
  }
);

export const config = {
  matcher: [
    // Match root path
    "/",
    // Match all paths except auth, login, register, and static assets
    "/((?!api/auth|login|register|_next/static|_next/image|growmystock_logo.svg|favicon.ico).*)",
  ],
};
