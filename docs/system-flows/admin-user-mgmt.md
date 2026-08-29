---
purpose: Complete reference for the admin user management system — approval workflow, email notifications, role management, and API routes.
sources: src/app/api/admin/users/route.ts, src/lib/email.ts, src/app/admin/users/page.tsx
triggers: Admin actions on /admin/users; email notifications triggered automatically on approval
related: [auth-flow.md](auth-flow.md), [../reference/api-routes.md](../reference/api-routes.md), [../reference/database-schema.md](../reference/database-schema.md)
last_updated: 2026-08-28
---

# Admin User Management

GrowMyStocks uses a manual admin approval model. Users cannot access any protected feature until an administrator explicitly grants access. This gives the team full control over who can use the platform at any time.

!!! note "August 2026 — document verified current"
    - Approval email (`sendApprovalEmail()`) added and now fires automatically on account approval.
    - `approval_status` enum extended with `unsubscribed` and `archived`.
    - Admin console navigation updated to include `/admin/cache` (Cache Management) alongside User Management.
    - Both GET and PATCH routes perform a live database role check on every request.

---

## Summary

| Aspect | Detail |
|---|---|
| User registration | Self-service at `/register` — anyone can create an account |
| Default state | All new accounts start as `pending` — login is blocked |
| Approval mechanism | Admin-only web console at `/admin/users` |
| Email notifications | Resend API — one email on registration, one on approval, one for password reset |
| User roles | `user`, `superuser`, `admin` — changeable post-approval |
| Security safeguard | System prevents demoting the last remaining admin account |
| Relevant source files | `src/app/api/admin/users/route.ts`, `src/lib/email.ts`, `src/app/admin/users/page.tsx` |

---

## User Account Lifecycle

Every account passes through a defined sequence of states. The diagram below shows the complete path from registration to active use, including all email touchpoints.

```
User visits /register and submits username, email, password
↓
Server validates input (origin check, rate limit, Zod schema)
↓
Account created in database  →  approval_status = "pending"
↓
[EMAIL 1] Registration confirmation sent to user via Resend
  "Welcome — your account is pending admin approval"
↓
Admin logs in and opens /admin/users
Admin sees account in "Pending Approvals" tab
↓
Admin clicks "Approve"                   Admin clicks "Reject"
↓                                        ↓
approval_status = "approved"            approval_status = "rejected"
approved_by = admin ID                  rejected_reason saved
approved_at = timestamp                     ↓
↓                                   User cannot log in
[EMAIL 2] Approval email sent                (rejection shown at login)
  "Your account is approved!"
↓
User clicks "Log In Now" → /login
↓
User accesses dashboard and all platform features
```

### Account States at a Glance

| State | What it means | Can the user log in? |
|---|---|---|
| `pending` | Account created, waiting for admin review | No — "Your account is awaiting admin approval." |
| `approved` | Admin has granted access | Yes — full access based on role |
| `rejected` | Admin has denied the account | No — "Your account request was rejected." |
| `unsubscribed` | User unsubscribed via email list-unsubscribe link | No — "Your account has been deactivated." |
| `archived` | Soft-deleted by admin, or auto-archived when a rejected record is replaced by a fresh registration | No — "This account no longer exists." |

!!! tip "Re-approval is possible"
    An admin can change a user's status at any time. A rejected user can be re-approved and an approved user can be rejected. The approve/reject buttons are available for all users in the All Users tab.

---

## Admin Console UI

The admin area consists of two pages, both restricted to users with the `admin` role:

- `/admin/users` — User Management (this document)
- `/admin/cache` — Cache Management (prediction and data cache diagnostics)

!!! tip "Access control"
    The page checks the session on load and redirects non-admins to the homepage. The API routes perform an independent live role check on every request — the UI check alone is not relied upon for security.

### Two-Tab Interface

**Tab 1 — Pending Approvals**

Shows only accounts with `approval_status = "pending"`. The count of pending accounts is shown as a badge on the tab. This is the default view when the page loads.

**Tab 2 — All Users**

Shows all accounts regardless of status. Use this view to find specific users, check login history, or change roles for already-approved accounts.

A search field allows filtering by username (partial match). A "Refresh" button reloads the list without navigating away.

### User Table Columns

| Column | Description |
|---|---|
| Username | The user's chosen display name (unique) |
| Email | The user's email address as registered |
| Status | Colour-coded badge: amber = pending, green = approved, red = rejected, slate = unsubscribed, gray = archived |
| Role | Inline dropdown — admin can change role directly from the table row (prompts confirmation before applying) |
| Created At | Date the account was registered |
| Last Login | Most recent successful login, or "Never" |
| Actions | Approve / Reject buttons for pending users; a single toggle button for approved or rejected users |

---

## Approve and Reject Actions

### Approving a User

1. Admin clicks "Approve" next to a pending user.
2. The browser sends `PATCH /api/admin/users` with `{ userId, approval_status: "approved" }`.
3. The server verifies the requesting session belongs to an admin.
4. The database record is updated: `approval_status = "approved"`, `approved_by` set to the admin's user ID, `approved_at` set to current timestamp, `rejected_reason` cleared.
5. The server fetches the user's email address and username from the database.
6. If an email address is on file, `sendApprovalEmail()` is called. If it fails, the failure is logged and the response is still 200 OK.
7. The admin console refreshes the user list automatically.

### Rejecting a User

1. Admin clicks "Reject" next to a pending (or previously approved) user.
2. A browser prompt asks the admin to enter a rejection reason (required; pressing Cancel aborts).
3. The browser sends `PATCH /api/admin/users` with `{ userId, approval_status: "rejected", rejected_reason: "..." }`.
4. The database record is updated: `approval_status = "rejected"`, `rejected_reason` saved, `approved_by` set to the rejecting admin's ID (audit trail).
5. No email is sent on rejection in the current implementation.
6. The admin console refreshes the user list.

!!! warning "No rejection email currently"
    Users are not automatically notified when their account is rejected. If your workflow requires notifying rejected applicants, this would need to be added to `src/lib/email.ts` and called from the PATCH handler — following the same pattern as `sendApprovalEmail()`.

---

## Role Management

Roles control access levels and quota limits. An admin can change any user's role directly from the user management table using the inline role dropdown.

| Role | Platform access | Usage quotas | Can manage users? |
|---|---|---|---|
| `user` | All core features (dashboard, portfolio, watchlist, stock search) | Standard limits (watchlist size, portfolio size, daily lookups) | No |
| `superuser` | All core features, higher quota allowances | Elevated thresholds (defined in `role_limits` table) | No |
| `admin` | All features plus `/admin/users` and cache diagnostics | Unlimited | Yes |

### Last-Admin Safeguard

The system prevents an admin from demoting themselves or another admin if there is only one admin account remaining:

```
Admin attempts to change role to "superuser" for user X
↓
Server counts: SELECT COUNT(*) FROM users WHERE role = "admin"
  [count > 1] → proceed with role change
  [count = 1] → check: is user X the only admin?
    [yes] → HTTP 400 "Cannot demote the only admin"
    [no]  → proceed (the other admin is someone else)
```

!!! warning "Role changes take effect at next login"
    The user's role is embedded in their JWT session token at login time. A role change is recorded immediately in the database, but the affected user will not see the new quota limits until they log out and back in.

---

## Email Notification System

All outbound email is sent through **Resend** via `src/lib/email.ts`, which exports three functions, each using a separate API key.

| Email type | Function | When sent | API key env var |
|---|---|---|---|
| Registration confirmation | `sendRegistrationEmail()` | Immediately after new account is created | `resend_reg_api_key` |
| Account approved | `sendApprovalEmail()` | Immediately after admin approves an account | `resend_reg_final_api_key` |
| Password reset link | `sendPasswordResetEmail()` | When user submits the forgot-password form | `RESEND_API_KEY` |

**Shared variable:** `RESEND_FROM_EMAIL` — the "From" address on all emails, default `noreply@growmystock.com`.

Using separate API keys allows independent key rotation and separate monitoring in the Resend dashboard.

### Registration Confirmation Email

Sent automatically on successful registration. Sets user expectations about the manual approval process.

- **Subject:** "Welcome to GrowMyStock — Account Pending Approval"
- **Contains login link:** No — users cannot log in until approved
- **If email send fails:** Warning logged; user account is still created successfully

### Account Approval Email

Sent automatically when an admin approves a user account. This is the user's signal that they can now log in.

- **Subject:** "Your GrowMyStock Account Has Been Approved!"
- **Contains:** Personalised greeting, confirmation of approval, "Log In Now" CTA button linking to `https://growmystock.com/login`, plain-text fallback URL
- **If user has no email on file:** Email silently skipped (no error)
- **If email send fails:** Error logged; admin action still returns 200 OK

The approval email logic in the PATCH handler:

```
approval_status === "approved"?
  [yes] ↓
SELECT email, username FROM users WHERE id = userId
user.email exists?
  [no]  → skip (no email sent, no error)
  [yes] ↓
try {
  await sendApprovalEmail(user.email, user.username)
} catch (emailErr) {
  logger.error("Failed to send approval email", { emailErr, targetUserId })
  // response is NOT affected — continues to HTTP 200
}
```

### Password Reset Email

Sent when a user submits the forgot-password form. Contains a time-limited, single-use link.

- **Subject:** "Reset your GrowMyStock password"
- **Link expiry:** 1 hour from time of request
- **Link reuse:** Single use only — consumed on successful password change
- **Eligible accounts:** Only `approval_status = "approved"` accounts can receive reset emails

### Email Failure Resilience

Email failures never block the primary user action:

| Email | Failure handling | User impact |
|---|---|---|
| Registration confirmation | Caught, logged as `warning` | Account still created; no confirmation email |
| Approval notification | Caught, logged as `error` | User's account is approved in the database; they can log in; no notification received |
| Password reset link | Propagates to outer handler; endpoint returns HTTP 200 (silent) | User does not receive the reset link |

!!! warning "Monitor for email failures"
    Because email failures are non-fatal and the user sees no indication, it is important to monitor server logs for "Failed to send approval email" entries. A high rate may indicate a misconfigured or expired Resend API key.

---

## API Route — GET /api/admin/users

Returns a list of users for display in the admin console.

**Authentication:** Requires a valid session with `role = "admin"`. Returns 401 if no session; 403 if the session belongs to a non-admin.

**Query parameters (all optional):**

| Parameter | Values | Effect |
|---|---|---|
| `status` | `pending`, `approved`, `rejected` | Filter results to users with that approval status |
| `role` | `user`, `superuser`, `admin` | Filter results to users with that role |
| `search` | Any text | Returns users whose username contains this string (partial match, case-insensitive) |

**Response fields per user:** `id`, `username`, `email`, `role`, `approval_status`, `created_at`, `last_login`, `rejected_reason`.

---

## API Route — PATCH /api/admin/users

Updates a user's approval status, role, or both. Triggers the approval email when `approval_status` is set to `"approved"`.

**Authentication:** Same as GET — requires admin session.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | number | Yes | ID of the user to update |
| `approval_status` | string | No | One of: `"pending"`, `"approved"`, `"rejected"`, `"unsubscribed"`, `"archived"` |
| `rejected_reason` | string | No | Required when `approval_status = "rejected"`; defaults to "No reason provided" |
| `role` | string | No | `"user"`, `"superuser"`, or `"admin"` |

**Database fields written on approval:**

| Field | Value set |
|---|---|
| `approval_status` | `"approved"` |
| `approved_by` | ID of the admin making the request |
| `approved_at` | Current server timestamp |
| `rejected_reason` | `NULL` (cleared) |

**Responses:**

| Status | Situation |
|---|---|
| 200 OK | Update succeeded (including if approval email failed to send) |
| 400 Bad Request | Missing `userId`, no fields to update, or last-admin demotion attempt |
| 401 Unauthorized | No valid session |
| 403 Forbidden | Session exists but the user is not an admin |
| 500 Internal Server Error | Unexpected database error |

---

## Database Schema

### users table (relevant columns)

| Column | Type | Description |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `username` | VARCHAR(255) | Unique display name chosen at registration |
| `email` | VARCHAR(255) | Unique email address; nullable (legacy accounts may have none) |
| `password_hash` | VARCHAR(255) | bcrypt hash (cost factor 10) |
| `role` | ENUM('user','superuser','admin') | Access level. Default: `user` |
| `approval_status` | ENUM('pending','approved','rejected','unsubscribed','archived') | Controls whether the account can log in. Default: `pending` |
| `approved_by` | INT (FK → users.id) | ID of the admin who last changed approval status |
| `approved_at` | DATETIME | Timestamp of the most recent approval action |
| `rejected_reason` | VARCHAR(255) | Free-text reason entered by the admin when rejecting |
| `last_login` | DATETIME | Automatically updated on each successful login |
| `created_at` | TIMESTAMP | Account creation time |

Indexes: `idx_users_approval_status`, `idx_users_role`.

### password_reset_tokens table

| Column | Type | Description |
|---|---|---|
| `id` | INT (auto-increment) | Primary key |
| `user_id` | INT (FK → users.id) | The account this token belongs to. Cascades on user deletion. |
| `token_hash` | VARCHAR(255) | SHA-256 hash of the raw token. The raw token is never stored. |
| `expires_at` | DATETIME | Token becomes invalid after this time (1 hour from creation) |
| `used_at` | DATETIME | Set when the token is consumed. NULL if still valid and unused. |
| `created_at` | TIMESTAMP | Row creation time |

---

## Test Coverage

### GET /api/admin/users test cases

| Test case | Expected outcome |
|---|---|
| No session present | HTTP 401 |
| Session belongs to a non-admin user | HTTP 403 |
| Admin session, no filters | HTTP 200 with user list |
| Admin session with `status`, `role`, and `search` filters | HTTP 200; SQL query verified to include correct WHERE clauses |

### PATCH /api/admin/users test cases

| Test case | Expected outcome |
|---|---|
| Approve a user (status update) | HTTP 200; database update verified with correct fields including `approved_by` |
| Approval email sent when user has an email address | `sendApprovalEmail()` called with correct email and username |
| Approval email skipped when user has no email address | `sendApprovalEmail()` not called; still returns HTTP 200 |
| Approval email send fails | `sendApprovalEmail()` throws; endpoint still returns HTTP 200 |
| Demote the only remaining admin | HTTP 400 — "Cannot demote the only admin" |
| Change role when multiple admins exist | HTTP 200; database update verified |

`sendApprovalEmail` is mocked using `jest.mock('@/lib/email', ...)` so no real Resend API calls are made during testing.

```bash
# Run all tests
npm test

# Run only the admin users test file
npx jest api_admin_users

# Run with verbose output
npx jest api_admin_users --verbose
```
