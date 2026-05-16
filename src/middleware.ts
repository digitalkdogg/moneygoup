import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export default withAuth(
  function middleware(req: NextRequest) {
    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ req, token }) => {
        const pathname = req.nextUrl.pathname;

        // Bypass if x-api-key is present and valid
        const apiKey = req.headers.get("x-api-key");
        const internalSecret = process.env.DEEPMONEY_INTERNAL_SECRET;

        if (apiKey && internalSecret && apiKey === internalSecret) {
          return true;
        }

        // Otherwise require a valid session token
        return !!token;
      },
    },
  }
);

export const config = {
  matcher: [
    "/((?!api/auth|login|register|forgot-password|reset-password|_next/static|_next/image|growmystock_logo.svg|favicon.ico).*)",
  ],
};
