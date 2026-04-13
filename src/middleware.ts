import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ req, token }) => {
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
  // Protect all routes except login, register, and public assets
  matcher: [
    "/((?!api/auth|login|register|_next/static|_next/image|growmystock_logo.svg|favicon.ico).*)",
  ],
};
