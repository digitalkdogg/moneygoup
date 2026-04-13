export { default } from "next-auth/middleware";

export const config = {
  // Protect all routes except login, register, and public assets
  matcher: [
    "/((?!api/auth|api/prediction/deepmoney|api/dashboard/deepmoney-picks|login|register|_next/static|_next/image|growmystock_logo.svg|favicon.ico).*)",
  ],
};
