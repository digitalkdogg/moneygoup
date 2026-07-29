"""
test_etf_rate_limit.py
----------------------
Replays the exact Yahoo Finance call pattern that performETFDiscovery uses
(27 ETFs, concurrency=1, 3.5s inter-request gap, 45s cooldown on 429s) and
reports per-ticker pass/fail.  Runs in isolation — no deepmoney sync needed.

Usage:
    python3 scripts/test_etf_rate_limit.py [--delay SECONDS] [--skip-db]

Options:
    --delay SECONDS   Override the inter-request delay (default: 3.5)
    --skip-db         Don't read etf_cycle_summary; just test Yahoo calls
"""

import json
import os
import sys
import time
import argparse
from datetime import datetime, timezone

import yfinance as yf

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

try:
    from dotenv import load_dotenv
    for env_file in ('.env.production', '.env.local', '.env'):
        path = os.path.join(PROJECT_ROOT, env_file)
        if os.path.exists(path):
            load_dotenv(path)
except ImportError:
    pass  # dotenv optional

WATCHLIST_PATH = os.path.join(PROJECT_ROOT, 'public', 'etf_theme_watchlist.json')

# Mirrors the values in etfDiscovery.ts
DEFAULT_DELAY_S   = 3.5
RETRY_BASE_S      = 10.0
MAX_ATTEMPTS      = 3
COOLDOWN_S        = 45.0

RATE_LIMIT_PHRASES = ('too many requests', '429', 'rate limit', 'throttl')

GREEN  = '\033[92m'
RED    = '\033[91m'
YELLOW = '\033[93m'
CYAN   = '\033[96m'
RESET  = '\033[0m'
BOLD   = '\033[1m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ts() -> str:
    return datetime.now(timezone.utc).strftime('%H:%M:%S')


def is_rate_limit(exc: Exception) -> bool:
    return any(p in str(exc).lower() for p in RATE_LIMIT_PHRASES)


def fetch_etf(ticker: str, cooldown_until: list) -> tuple[bool, str, float]:
    """
    Fetch ETF summary via yfinance, honouring a shared cooldown_until[0]
    timestamp (seconds since epoch).  Returns (success, message, elapsed_s).
    """
    # Respect shared cooldown
    wait = cooldown_until[0] - time.time()
    if wait > 0:
        print(f"  {YELLOW}[{ts()}] {ticker}: cooldown active — waiting {wait:.0f}s{RESET}")
        time.sleep(wait)

    t_start = time.time()
    last_exc = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            tkr = yf.Ticker(ticker)
            info = tkr.info  # equivalent to quoteSummary modules price+summaryDetail+etc.

            # Minimal sanity check — if Yahoo returned an empty dict we treat it
            # as a soft failure but not a rate-limit.
            if not info or info.get('quoteType') is None:
                elapsed = time.time() - t_start
                return False, f"empty response (quoteType missing)", elapsed

            qt = info.get('quoteType', '')
            price = info.get('regularMarketPrice') or info.get('currentPrice')
            elapsed = time.time() - t_start
            return True, f"quoteType={qt} price={price}", elapsed

        except Exception as exc:
            last_exc = exc
            if is_rate_limit(exc):
                # Extend shared cooldown
                cooldown_until[0] = max(cooldown_until[0], time.time() + COOLDOWN_S)
                if attempt < MAX_ATTEMPTS:
                    delay = RETRY_BASE_S * (2 ** (attempt - 1))
                    print(f"  {YELLOW}[{ts()}] {ticker}: 429 (attempt {attempt}/{MAX_ATTEMPTS}), "
                          f"retry in {delay:.0f}s — cooldown set to +{COOLDOWN_S:.0f}s{RESET}")
                    time.sleep(delay)
                else:
                    elapsed = time.time() - t_start
                    return False, f"rate-limited after {MAX_ATTEMPTS} attempts: {exc}", elapsed
            else:
                elapsed = time.time() - t_start
                return False, f"non-rate-limit error: {exc}", elapsed

    elapsed = time.time() - t_start
    return False, f"exhausted retries: {last_exc}", elapsed


def load_db_last_cycle():
    """Read the most recent etf_cycle_summary row from MySQL (optional)."""
    try:
        import mysql.connector
        conn = mysql.connector.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            user=os.getenv('DB_USER'),
            password=os.getenv('DB_PASSWORD'),
            database=os.getenv('DB_DATABASE'),
            port=int(os.getenv('DB_PORT', 3306)),
            connect_timeout=5,
        )
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT cycle_date, etfs_evaluated, etfs_qualified, etfs_persisted,
                   errors, created_at
            FROM etf_cycle_summary
            ORDER BY created_at DESC
            LIMIT 1
        """)
        row = cur.fetchone()
        conn.close()
        return row
    except Exception as exc:
        return {'_error': str(exc)}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--delay', type=float, default=DEFAULT_DELAY_S,
                        help=f'Inter-request delay in seconds (default: {DEFAULT_DELAY_S})')
    parser.add_argument('--skip-db', action='store_true', help='Skip DB summary lookup')
    args = parser.parse_args()

    print(f"\n{BOLD}{'='*62}{RESET}")
    print(f"{BOLD}  ETF Yahoo Rate-Limit Test — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}{RESET}")
    print(f"{BOLD}{'='*62}{RESET}")

    # Load watchlist
    with open(WATCHLIST_PATH) as f:
        watchlist = json.load(f)
    tickers = [e['ticker'] for e in watchlist]
    print(f"\n  Watchlist: {len(tickers)} tickers")
    print(f"  Delay:     {args.delay}s between requests")
    print(f"  Retry:     {MAX_ATTEMPTS} attempts, base backoff {RETRY_BASE_S}s, cooldown {COOLDOWN_S}s")

    # --- DB snapshot before ---
    if not args.skip_db:
        print(f"\n{BOLD}  Last etf_cycle_summary row (before test):{RESET}")
        row = load_db_last_cycle()
        if '_error' in row:
            print(f"  {YELLOW}  DB read failed: {row['_error']}{RESET}")
        else:
            print(f"  cycle_date={row.get('cycle_date')}  evaluated={row.get('etfs_evaluated')}  "
                  f"qualified={row.get('etfs_qualified')}  persisted={row.get('etfs_persisted')}")
            errs = row.get('errors') or ''
            if errs:
                print(f"  {RED}  errors: {errs[:200]}{'...' if len(errs)>200 else ''}{RESET}")

    print(f"\n{BOLD}  Fetching {len(tickers)} ETFs...{RESET}\n")

    results = []
    cooldown_until = [0.0]  # shared mutable ref; mirrors rateLimitCooldownUntil in TS

    run_start = time.time()

    for i, ticker in enumerate(tickers):
        if i > 0:
            time.sleep(args.delay)

        print(f"  [{i+1:2d}/{len(tickers)}] {ticker:<6s} ", end='', flush=True)
        ok, msg, elapsed = fetch_etf(ticker, cooldown_until)

        if ok:
            print(f"{GREEN}OK{RESET}    ({elapsed:.1f}s)  {msg}")
        else:
            rate_hit = any(p in msg.lower() for p in RATE_LIMIT_PHRASES)
            color = YELLOW if rate_hit else RED
            label = '429' if rate_hit else 'FAIL'
            print(f"{color}{label}{RESET}  ({elapsed:.1f}s)  {msg}")

        results.append({'ticker': ticker, 'ok': ok, 'msg': msg, 'elapsed': elapsed})

    total_s = time.time() - run_start

    # --- Summary ---
    passed = [r for r in results if r['ok']]
    failed = [r for r in results if not r['ok']]
    rate_limited = [r for r in failed if any(p in r['msg'].lower() for p in RATE_LIMIT_PHRASES)]

    print(f"\n{BOLD}{'='*62}{RESET}")
    print(f"{BOLD}  Results{RESET}")
    print(f"{'='*62}")
    print(f"  Total time : {total_s:.1f}s  ({total_s/60:.1f} min)")
    print(f"  Passed     : {GREEN}{len(passed)}/{len(tickers)}{RESET}")
    print(f"  Rate-limited: {YELLOW}{len(rate_limited)}/{len(tickers)}{RESET}")
    print(f"  Other errors: {RED}{len(failed)-len(rate_limited)}/{len(tickers)}{RESET}")

    if failed:
        print(f"\n  {BOLD}Failed tickers:{RESET}")
        for r in failed:
            label = f"{YELLOW}429{RESET}" if any(p in r['msg'].lower() for p in RATE_LIMIT_PHRASES) else f"{RED}ERR{RESET}"
            print(f"    {label}  {r['ticker']:<6s}  {r['msg'][:80]}")

    # Verdict
    print()
    if len(rate_limited) == 0:
        print(f"  {GREEN}{BOLD}PASS — no rate-limit errors.{RESET}")
    elif len(rate_limited) <= 3:
        print(f"  {YELLOW}{BOLD}MARGINAL — {len(rate_limited)} rate-limit error(s). "
              f"Consider increasing --delay or RATE_LIMIT_COOLDOWN_MS.{RESET}")
    else:
        print(f"  {RED}{BOLD}FAIL — {len(rate_limited)} rate-limit errors. "
              f"Throttling is still insufficient.{RESET}")

    print(f"{BOLD}{'='*62}{RESET}\n")
    sys.exit(0 if len(rate_limited) == 0 else 1)


if __name__ == '__main__':
    main()
