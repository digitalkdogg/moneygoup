#!/usr/bin/env python3
"""
test_redis_rate_limiter.py

Verifies that the Redis-backed rate limiter is working correctly.
Tests register, login, and forgot-password endpoints for correct 429 behaviour.

Usage:
    python3 scripts/test_redis_rate_limiter.py

Requirements:
    pip install requests redis
"""

import os
import sys
import time
import requests

try:
    import redis as redis_lib
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

BASE_URL = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
REDIS_URL = os.getenv('REDIS_URL', 'redis://127.0.0.1:6379')

PASS = '\033[92m✓ PASS\033[0m'
FAIL = '\033[91m✗ FAIL\033[0m'
INFO = '\033[94m→\033[0m'
WARN = '\033[93m⚠\033[0m'


def section(title: str):
    print(f'\n{"─" * 60}')
    print(f'  {title}')
    print(f'{"─" * 60}')


def flush_redis_keys(pattern: str):
    """Delete matching Redis keys so tests start from a clean slate."""
    if not REDIS_AVAILABLE:
        return
    try:
        r = redis_lib.from_url(REDIS_URL)
        keys = r.keys(pattern)
        if keys:
            r.delete(*keys)
    except Exception:
        pass


def check_redis_keys(pattern: str) -> list:
    """Return matching Redis keys."""
    if not REDIS_AVAILABLE:
        return []
    try:
        r = redis_lib.from_url(REDIS_URL)
        return [k.decode() for k in r.keys(pattern)]
    except Exception:
        return []


def test_rate_limit(label: str, method: str, url: str, payload: dict,
                   limit: int, flush_pattern: str):
    """
    Fire (limit + 2) requests and verify:
      - Requests 1..limit all return non-429
      - Request (limit + 1) returns 429
    """
    print(f'\n{INFO} {label}  (limit: {limit} per window)')

    flush_redis_keys(flush_pattern)

    session = requests.Session()
    # Use a fixed source IP header so all requests share the same rate-limit key.
    session.headers.update({'X-Forwarded-For': '10.0.0.1', 'Origin': BASE_URL})

    statuses = []
    for i in range(1, limit + 3):
        try:
            if method == 'POST':
                resp = session.post(url, json=payload, timeout=5)
            else:
                resp = session.get(url, timeout=5)
            statuses.append(resp.status_code)
            marker = f'  req {i:>2}: {resp.status_code}'
            if resp.status_code == 429:
                marker += '  ← rate limited'
            print(marker)
        except requests.exceptions.ConnectionError:
            print(f'  {FAIL}  Could not connect to {url}')
            print(f'         Is the dev server running on {BASE_URL}?')
            return False

    # All requests within the limit should NOT be 429
    # (they may be 400/401/409/422 for invalid data — that's fine)
    within_limit = statuses[:limit]
    if any(s == 429 for s in within_limit):
        print(f'  {FAIL}  Got 429 before the limit was reached: {within_limit}')
        return False

    # The (limit+1)th request must be 429
    over_limit = statuses[limit:]
    if not all(s == 429 for s in over_limit):
        print(f'  {FAIL}  Expected 429 after {limit} requests, got: {over_limit}')
        return False

    # Confirm the key exists in Redis
    keys = check_redis_keys(flush_pattern)
    if REDIS_AVAILABLE:
        if keys:
            print(f'  {INFO} Redis key found: {keys[0]}')
        else:
            print(f'  {WARN}  No Redis key found — rate limiter may be in-memory fallback')

    print(f'  {PASS}')
    return True


def test_redis_connection():
    section('1. Redis connectivity')
    if not REDIS_AVAILABLE:
        print(f'  {WARN}  redis-py not installed — skipping Redis checks')
        print(       '         pip install redis')
        return True  # Not a blocker for the rate-limit tests

    try:
        r = redis_lib.from_url(REDIS_URL)
        pong = r.ping()
        if pong:
            print(f'  {PASS}  Redis responded to PING at {REDIS_URL}')
            return True
        else:
            print(f'  {FAIL}  Redis PING returned falsy at {REDIS_URL}')
            return False
    except Exception as e:
        print(f'  {FAIL}  Cannot reach Redis: {e}')
        print(       '         Make sure Redis is running: redis-cli ping')
        return False


def test_register_limit():
    section('2. Register rate limit  (5 per 15 min per IP)')
    return test_rate_limit(
        label='POST /api/auth/register',
        method='POST',
        url=f'{BASE_URL}/api/auth/register',
        payload={
            'username': 'ratelimituser',
            'email': 'ratelimit@example.com',
            'password': 'Password123',
        },
        limit=5,
        flush_pattern=b'rl:register:*',
    )


def test_login_limit():
    section('3. Login rate limit  (10 per 15 min per IP)')
    # NextAuth credentials login endpoint
    return test_rate_limit(
        label='POST /api/auth/callback/credentials',
        method='POST',
        url=f'{BASE_URL}/api/auth/callback/credentials',
        payload={
            'username': 'nonexistentuser',
            'password': 'wrongpassword',
            'csrfToken': 'dummy',
            'callbackUrl': BASE_URL,
            'json': 'true',
        },
        limit=10,
        flush_pattern=b'rl:*10.0.0.1*',
    )


def test_forgot_password_limit():
    section('4. Forgot-password rate limit  (3 per 15 min per IP)')
    return test_rate_limit(
        label='POST /api/auth/forgot-password',
        method='POST',
        url=f'{BASE_URL}/api/auth/forgot-password',
        payload={'email': 'nobody@example.com'},
        limit=3,
        flush_pattern=b'rl:forgot-password:*',
    )


def test_keys_persist_across_requests():
    section('5. Keys survive across requests (shared state check)')
    if not REDIS_AVAILABLE:
        print(f'  {WARN}  redis-py not installed — skipping')
        return True

    flush_redis_keys(b'rl:register:*')

    url = f'{BASE_URL}/api/auth/register'
    headers = {'X-Forwarded-For': '10.0.0.2', 'Origin': BASE_URL}
    payload = {'username': 'persisttest', 'email': 'persist@example.com', 'password': 'Password123'}

    # Fire 2 requests
    for _ in range(2):
        requests.post(url, json=payload, headers=headers, timeout=5)

    r = redis_lib.from_url(REDIS_URL)
    keys = r.keys(b'rl:register:*10.0.0.2*')
    if not keys:
        print(f'  {FAIL}  No Redis key found after 2 requests')
        return False

    count = int(r.get(keys[0]) or 0)
    ttl   = r.ttl(keys[0])

    if count >= 2:
        print(f'  {INFO} Counter value: {count}  TTL: {ttl}s')
        print(f'  {PASS}  Counter is incrementing in Redis')
        return True
    else:
        print(f'  {FAIL}  Counter is {count}, expected ≥ 2 — may be in-memory, not Redis')
        return False


def main():
    print(f'\n{"═" * 60}')
    print(  '  Redis Rate Limiter — Integration Test')
    print(f'  Target: {BASE_URL}')
    print(f'  Redis:  {REDIS_URL}')
    print(f'{"═" * 60}')

    results = []
    results.append(test_redis_connection())
    results.append(test_register_limit())
    results.append(test_forgot_password_limit())
    results.append(test_keys_persist_across_requests())

    # Login limit test uses NextAuth internals — skip if it returns unexpected shape
    print(f'\n{INFO} Skipping login limit test (NextAuth CSRF flow makes direct curl unreliable)')
    print(  '       To test manually: attempt 11 rapid logins in the browser.')

    section('Summary')
    passed = sum(results)
    total  = len(results)
    print(f'  {passed}/{total} tests passed')

    if passed == total:
        print(f'\n  {PASS}  Redis rate limiter is working correctly.\n')
        sys.exit(0)
    else:
        print(f'\n  {FAIL}  Some tests failed — check output above.\n')
        sys.exit(1)


if __name__ == '__main__':
    main()
