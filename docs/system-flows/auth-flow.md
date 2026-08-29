---
purpose: Complete reference for authentication flows — registration, login, password reset — and all security controls, middleware behaviour, user roles, and approval states.
sources: src/proxy.ts, src/lib/auth.ts, src/app/api/auth/register/route.ts, src/app/api/auth/forgot-password/route.ts, src/app/api/auth/reset-password/route.ts, src/utils/rateLimiter.ts, src/lib/email.ts
triggers: User actions on /register, /login, /forgot-password, /reset-password; admin actions on /admin/users
related: [admin-user-mgmt.md](admin-user-mgmt.md), [../reference/api-routes.md](../reference/api-routes.md), [../reference/database-schema.md](../reference/database-schema.md)
last_updated: 2026-08-28
---

# Authentication Flow

MoneyGoUp uses **NextAuth.js v4** with a Credentials provider backed by a MySQL `users` table. Sessions are JWT-based and stored in an HttpOnly cookie. All new accounts start `pending` and require manual admin approval before they can log in.

!!! note "June 2026 updates"
    - Middleware entry point renamed from `src/middleware.ts` to `src/proxy.ts` (behaviour unchanged).
    - `PUBLIC_PATHS` expanded to include marketing, legal, and SEO routes.
    - Internal bypass now enforces a minimum 32-byte secret.
    - Numeric rate-limit caps documented: register 5/15 min, login 10/15 min.

---

## System Summary

| Aspect | Implementation |
|---|---|
| Authentication library | NextAuth.js v4 (`next-auth ^4.24`) |
| Session strategy | JWT — stored in an HttpOnly cookie |
| Password hashing | bcryptjs, cost factor 10 |
| Input validation | Zod schemas on all API routes |
| Email service | Resend — registration confirmation, admin approval, password reset |
| Route protection | `src/proxy.ts` (NextAuth `withAuth` middleware) |
| Rate limiting | Redis-backed `RedisRateLimiter` instances via `checkRateLimit` |
| Internal API bypass | `x-api-key: DEEPMONEY_INTERNAL_SECRET` — must be ≥ 32 bytes or the bypass is disabled |

---

## Security Layer Stack

Every auth API route passes through multiple independent controls before reaching business logic:

```
Origin Check (checkOrigin)      — Blocks requests from untrusted origins
↓
Rate Limit (checkRateLimit)     — Per-IP Redis counter; 429 if exhausted
↓
Zod Schema Validation           — Rejects malformed or policy-violating input (400)
↓
Business Logic                  — DB lookup, bcrypt compare, token validation
↓
Response
```

### Origin Check

`checkOrigin()` (`src/utils/originCheck.ts`) validates the `Origin` header against `ALLOWED_ORIGINS` (falls back to `NEXTAUTH_URL`). The policy is fail-closed: if no allowed origins are configured it blocks the request with 500. Safari Private Browsing's `Origin: null` is treated as missing and falls through to Referer validation. Applied to all state-changing auth routes.

### Rate Limits

| Route | Limiter | Window and Cap |
|---|---|---|
| `POST /api/auth/register` | `registerLimiter` | 5 / 15 min per IP (+ username as secondary key) |
| `POST /api/auth/forgot-password` | `forgotPasswordLimiter` | 3 / 15 min per IP |
| `POST /api/auth/reset-password` | `resetPasswordLimiter` | 5 / 15 min per IP |
| Login (NextAuth `authorize`) | `loginLimiter` | 10 / 15 min per IP |

All limiters are `RedisRateLimiter` instances — counters are shared across workers. `getClientIP()` only trusts forwarded headers when the direct source IP is in `TRUSTED_PROXIES`.

---

## Password Policy

!!! note "Updated May 2026 — minimum raised from 6 to 8 characters; digit requirement added"

**Current requirements (enforced at both API and client levels):**

- Minimum **8 characters**
- Maximum **100 characters**
- Must contain **at least one digit** (0–9)

| Location | Mechanism | Failure behaviour |
|---|---|---|
| Register page (`src/app/register/page.tsx`) | JavaScript check before `fetch()` | Inline error; API call never made |
| Reset Password page (`src/app/reset-password/page.tsx`) | JavaScript check before `fetch()` | Inline error; API call never made |
| `POST /api/auth/register` | Zod `z.string().min(8).max(100).regex(/\d/)` | HTTP 400 |
| `POST /api/auth/reset-password` | Zod `z.string().min(8).max(100).regex(/\d/)` | HTTP 400 |

Both pages display the hint text **"At least 8 characters and one number."** below the password field.

---

## Registration Flow

New users self-register at `/register`. Accounts are placed in `pending` state immediately after creation and cannot log in until an admin approves them.

```
User fills Register form (/register)
↓
Client-side check: password ≥ 8 chars AND contains digit
  [fails] → inline error displayed, form blocked
  [passes] ↓
POST /api/auth/register { username, email, password, website }
↓
Origin check → Rate limit (5/15min per IP + username) → Zod validation
↓
Honeypot: website field non-empty? → silent fake 201 (bot blocked)
↓
SELECT: email already exists (non-rejected)?  → 409 "An account with this email address is already registered."
SELECT: username already taken (non-rejected)? → 409 "This username is already taken."
↓
Any prior rejected record matching email/username is archived
(approval_status='archived', conflicting field suffixed with '_archived')
↓
bcrypt.hash(password, 10)
INSERT users (username, email, password_hash, approval_status='pending')
↓
sendRegistrationEmail() via Resend  [failure is non-fatal; logged as warning]
↓
HTTP 201 → { message, userId, approvalStatus: "pending" }
↓
User sees success banner: "Registration successful! Your account is pending admin approval..."
↓
Admin reviews account in /admin/users → approves or rejects
```

### Registration API — Check Matrix

| Check | Result on failure |
|---|---|
| Origin header mismatch | Blocked before rate limit |
| Rate limit exceeded | HTTP 429 |
| Honeypot `website` field non-empty | Silent fake 201 with `userId: 999999` — bot does not learn it was rejected |
| Username < 3 or > 50 chars | HTTP 400 — Zod error |
| Invalid email format | HTTP 400 — Zod error |
| Password < 8 chars | HTTP 400 — "Password must be at least 8 characters long" |
| Password has no digit | HTTP 400 — "Password must contain at least one number" |
| Email already registered (non-rejected) | HTTP 409 |
| Username already taken (non-rejected) | HTTP 409 |
| All checks pass | HTTP 201 — account created, pending approval |

**Success response:**

```json
{
  "message": "Account created and awaiting admin approval",
  "userId": 42,
  "approvalStatus": "pending"
}
```

---

## Login Flow

Authentication is handled by NextAuth.js. The login page at `/login` calls `signIn('credentials', ...)`, which invokes the `authorize` callback in `src/lib/auth.ts`.

```
User fills Login form (/login)
↓
signIn('credentials', { username, password, redirect: false })
↓
NextAuth authorize callback (src/lib/auth.ts)
↓
Rate limit check by IP (loginLimiter — 10/15min)
↓
SELECT users WHERE username = ?
  [not found] → bcrypt.compare against dummy hash (timing guard)
             → return null → "Invalid username or password"
  [found] ↓
bcrypt.compare(password, password_hash)
  [mismatch] → return null → "Invalid username or password"
  [match] ↓
evaluateApprovalStatus(approval_status, rejected_reason)
  [pending]      → throw ACCOUNT_PENDING_APPROVAL → "Your account is awaiting admin approval."
  [rejected]     → throw ACCOUNT_REJECTED        → "Your account request was rejected."
  [unsubscribed] → throw ACCOUNT_REJECTED        → "Your account has been deactivated."
  [archived]     → throw ACCOUNT_REJECTED        → "This account no longer exists."
  [approved] ↓
UPDATE users SET last_login = NOW() (async, non-blocking)
JWT issued → HttpOnly session cookie set
session.user = { id, name, role, approvalStatus }
↓
window.location.href = '/dashboard'  (hard redirect to pick up fresh session)
```

### Login Error Messages

| Situation | Message shown |
|---|---|
| Wrong username or password | "Invalid username or password" |
| Account pending admin approval | "Your account is awaiting admin approval." |
| Account rejected by admin | "Your account request was rejected. Contact support/admin." |
| Session previously expired | Amber banner: "Your session expired. Please sign in again." (`?reason=expired`) |

### Session Configuration

| Setting | Value |
|---|---|
| Strategy | JWT |
| Default max age | 30 days (overridable via `SESSION_MAX_AGE` env var) |
| Cookie max age | Synced with JWT max age via `SESSION_MAX_AGE_SECS` constant in `src/lib/auth.ts` |
| Cookie name | `__Secure-next-auth.session-token` (HTTPS) / `next-auth.session-token` (HTTP) |
| Cookie flags | HttpOnly, SameSite=Lax, Secure on HTTPS |
| JWT payload | `id`, `name` (username), `role`, `approvalStatus` |

!!! tip "AUTH-2 fix"
    The `SESSION_MAX_AGE_SECS` constant in `src/lib/auth.ts` is used for both the JWT `session.maxAge` and the cookie `options.maxAge`. Setting the `SESSION_MAX_AGE` environment variable now correctly controls both the JWT lifetime and the browser cookie expiry.

---

## Password Reset Flow

The flow spans two pages and three API calls. The forgot-password step always returns a generic success message regardless of whether the email matched an account, preventing email enumeration.

### Step 1 — Request a Reset Link

```
User visits /forgot-password
↓
POST /api/auth/forgot-password { email }
↓
Origin check → Rate limit (3 req/15 min per IP)
↓
Zod: valid email format?
  [no] → HTTP 200 success (identical to success — no enumeration)
  [yes] ↓
SELECT users WHERE email = ? AND approval_status = 'approved'
  [not found or not approved] → HTTP 200 success (silent)
  [found] ↓
DELETE existing unused tokens for this user
INSERT password_reset_tokens (user_id, token_hash=SHA-256(rawToken), expires_at=+1hr)
sendPasswordResetEmail(email, resetUrl) via Resend
↓
HTTP 200: "If that email address is registered, you will receive a password reset link shortly."
```

### Step 2 — Validate the Token (page load)

```
User clicks email link → /reset-password?token=<64-char hex>
↓
Page mounts → GET /api/auth/reset-password?token=...
↓
token.length === 64?
  [no] → { valid: false, message: "Invalid or missing reset token." }
  [yes] ↓
SHA-256(rawToken) → lookup in password_reset_tokens
  [not found] → { valid: false, message: "Invalid or expired reset link." }
  [found] ↓
token.used_at IS NOT NULL?  → { valid: false, message: "This reset link has already been used." }
new Date() > expires_at?    → { valid: false, message: "This reset link has expired." }
  [all pass] → { valid: true }
↓
Page renders password form (if valid) or error + "Request New Reset Link" button (if invalid)
```

### Step 3 — Submit New Password

```
User enters new password + confirmation
↓
Client-side check: password ≥ 8 chars AND contains digit AND passwords match
  [fails] → inline error, API call blocked
  [passes] ↓
POST /api/auth/reset-password { token, password }
↓
Origin check → Rate limit (5 req/15 min per IP)
Zod: token length === 64, password min 8 + digit
  [fails] → HTTP 400 with first Zod error message
  [passes] ↓
SHA-256(token) → lookup in password_reset_tokens
  [not found] → HTTP 400 "Invalid or expired reset link."
  [used]      → HTTP 400 "This reset link has already been used."
  [expired]   → HTTP 400 "This reset link has expired."
  [valid] ↓
bcrypt.hash(newPassword, 10)
UPDATE users SET password_hash = ?, modified_at = NOW() WHERE id = ?
UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL
↓
HTTP 200 { "message": "Password updated successfully." }
↓
Page shows success banner → redirects to /login after 3 seconds
```

!!! tip "Token mechanics"
    A 32-byte cryptographically random value is generated (`randomBytes(32).toString('hex')`), producing a 64-character hex string. Only the SHA-256 hash of this string is stored in the database. The raw token travels only in the email link URL — it never appears in the database.

---

## Authentication UI Pages

| Page | File | Key behaviour |
|---|---|---|
| `/login` | `src/app/login/page.tsx` | Client component; calls `signIn('credentials', { redirect: false })`; reads `?reason=expired` to show amber banner; hard `window.location.href` redirect on success to pick up cookie |
| `/register` | `src/app/register/page.tsx` | Client component; client-side password check before API call; hint text displayed; success shows green pending banner without redirect |
| `/forgot-password` | `src/app/forgot-password/page.tsx` | Always shows neutral success message after submission regardless of email match |
| `/reset-password` | `src/app/reset-password/page.tsx` | Client component in `<Suspense>`; validates token on mount; success banner + auto-redirect to `/login` after 3 seconds |

---

## Authentication API Routes

| Route | Method | Purpose | Auth required? |
|---|---|---|---|
| `/api/auth/register` | POST | Create new user account (pending approval) | No |
| `/api/auth/forgot-password` | POST | Request a password reset email | No |
| `/api/auth/reset-password` | GET | Validate a reset token (non-destructive) | No |
| `/api/auth/reset-password` | POST | Consume token and set new password | No |
| `/api/auth/[...nextauth]` | GET, POST | NextAuth.js session and token handling | No (public handler) |
| `/api/auth/cache-stats` | GET, DELETE | Cache diagnostics / cache clear — both currently return 403 (placeholder) | Yes — admin role |

All `/api/auth/**` routes are excluded from the middleware matcher.

---

## Middleware Route Guard

**File:** `src/proxy.ts`

!!! note "Renamed June 2026"
    The Next.js middleware entry point moved from `src/middleware.ts` to `src/proxy.ts`. All behaviour is unchanged — only the filename moved.

All application routes not in the exclusion list are protected by the NextAuth.js `withAuth` wrapper. The middleware also generates a unique nonce for the Content Security Policy on every request.

### Public paths (no session required)

The `PUBLIC_PATHS` array bypasses the session check but still receives the CSP:

- `/` — marketing landing
- `/login`, `/register`, `/forgot-password`, `/reset-password`
- `/contact`, `/api/contact`
- `/legal/privacy`, `/legal/terms`, `/legal/disclaimer`
- `/api/unsubscribe` — public by design, secured via HMAC-signed token
- `/opengraph-image` and login/register opengraph variants
- `/sitemap.xml`, `/robots.txt`
- `/api/analytics/model-accuracy` — publicly accessible to power the landing page's "Proven Track Record" section

The matcher itself excludes `/api/auth/**`, `/_next/static/**`, `/_next/image/**`, logo and favicon assets — the middleware function does not run for those paths at all.

### Per-request nonce-based CSP

The middleware generates a unique cryptographic nonce via `crypto.getRandomValues()` for every request. The nonce is injected into the `Content-Security-Policy` response header and passed to the root layout via the `x-nonce` request header. In development, `'unsafe-eval'` is added to `script-src` to support Next.js Fast Refresh.

### Internal API bypass

Requests carrying `x-api-key: <DEEPMONEY_INTERNAL_SECRET>` skip session validation entirely. **Constraint:** the secret is only honoured if it is ≥ 32 bytes long; shorter values silently disable the bypass.

Route handlers can call `isInternalRequest()` from `src/utils/internalAuth.ts` to detect the same internal caller with constant-time SHA-256 comparison.

!!! warning "AUTH-3 — deferred security debt"
    The middleware-level `x-api-key` bypass grants access to every protected route, including admin routes. The agreed remediation (move internal endpoints under `/api/internal/` and use short-lived tokens for dual-use routes) has not yet been implemented.

---

## User Roles

| Role | Access level | Quota limits |
|---|---|---|
| `user` | Standard — all core features within quota | Enforced — watchlist, portfolio, and daily lookup caps apply |
| `superuser` | Elevated — higher quota allowances | Enforced — same structure, higher thresholds from `role_limits` table |
| `admin` | Full — all features plus `/admin/users` and cache diagnostics | None — unlimited |

Role is embedded in the JWT at login. Role changes take effect at the user's **next login**.

---

## Account Approval States

| Status | Meaning | Login outcome | API access |
|---|---|---|---|
| `pending` | Newly registered; awaiting admin review | Blocked — "Your account is awaiting admin approval." | Denied — 403 |
| `approved` | Admin has granted access | Allowed — session issued | Allowed |
| `rejected` | Admin has denied the account | Blocked — "Your account request was rejected." | Denied — 403 |
| `unsubscribed` | User unsubscribed via email link | Blocked — "Your account has been deactivated." | Denied — 403 |
| `archived` | Soft-deleted or auto-archived on re-registration | Blocked — "This account no longer exists." | Denied — 403 |

!!! tip "AUTH-1 fix — runtime re-verification (May 2026)"
    Every authenticated API route calls `checkApprovalGuard(userId)` (`src/utils/approvalStatus.ts`) which re-queries `approval_status` from the database on every request. This prevents users whose accounts are suspended after login from continuing to access data with a still-valid session token. The guard fails closed — if the DB query errors, access is denied. As of the May 2026 sweep, `checkApprovalGuard()` is called from roughly 25 server route files.

!!! warning "Password reset restriction"
    The forgot-password route only sends a reset email if the account has `approval_status = 'approved'`. Pending, rejected, unsubscribed, and archived accounts cannot reset their passwords — the endpoint returns 200 silently to prevent enumeration.

---

## Email Notification System

All transactional emails are sent via **Resend**. Each function uses a separate API key for independent key rotation.

| Function | Trigger | Env var (API key) | Subject | Failure behaviour |
|---|---|---|---|---|
| `sendRegistrationEmail()` | User completes registration | `resend_reg_api_key` | "Welcome to GrowMyStock — Account Pending Approval" | Caught, logged as warning; registration still succeeds |
| `sendApprovalEmail()` | Admin approves an account | `resend_reg_final_api_key` | "Your GrowMyStock Account Has Been Approved!" | Caught, logged as error; admin action still returns 200 |
| `sendPasswordResetEmail()` | User requests password reset | `RESEND_API_KEY` | "Reset your GrowMyStock password" | Propagated to outer handler; endpoint returns 200 (silent) |

**Shared variable:** `RESEND_FROM_EMAIL` — sender address on all emails, default `noreply@growmystock.com`.

---

## Test Coverage

| Test file | Routes covered | Key scenarios |
|---|---|---|
| `api_auth_register.test.ts` | POST /api/auth/register | Happy path (201), boundary password (exactly 8 chars + digit), email conflict (409), username conflict (409), too short (400), no digit (400), rate limit (429). Email mocked. |
| `api_auth_reset_password.test.ts` | GET and POST /api/auth/reset-password | GET: valid token, wrong length, not found, used, expired. POST: happy path, DB writes verified, token wrong length, not found, used, expired, password too short, no digit, boundary 8 chars, rate limit, origin block. |
| `api_auth_forgot_password.test.ts` | POST /api/auth/forgot-password | Email enumeration protection, token creation, Resend call. |
| `api_admin_users.test.ts` | GET and PATCH /api/admin/users | Approval status update, role update, last-admin safeguard, approval email paths (sent / skipped when no email / fails non-fatally). |
