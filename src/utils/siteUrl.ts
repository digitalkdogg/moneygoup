/**
 * Canonical public URL of this Next.js instance.
 *
 * Resolution order (server-side):
 *   1. NEXT_PUBLIC_SITE_URL — only set if the browser bundle needs a different
 *      URL than the server uses. Rare.
 *   2. NEXTAUTH_URL — the canonical URL. Set this in .env.local / .env.production
 *      and it covers NextAuth callbacks, originCheck, sitemap, robots, and all
 *      metadata bases.
 *   3. 'https://growmystocks.com' — hardcoded production fallback so SSR never
 *      crashes if both vars are missing.
 */
export const SITE_URL: string =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXTAUTH_URL ||
  'https://growmystocks.com'
