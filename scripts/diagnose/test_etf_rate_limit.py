"""
test_etf_rate_limit.py
----------------------
Simulates the condition that causes "Too Many Requests" in performETFDiscovery:

  Phase 1 — Quota depletion (simulates enrichTickers running before ETF
             discovery): fires rapid-fire Yahoo calls for a configurable number
             of stock tickers so the session quota is in the same state it
             would be mid-sync.

  Phase 2 — Pre-flight pause (mirrors the 75s pause added to etfDiscovery.ts).

  Phase 3 — ETF candidate loop: fetches all 27 watchlist ETFs with 3.5s gaps
             and the 45s shared cooldown, then reports pass/fail per ticker.

Running in isolation (no --burst) skips Phase 1 and just tests the ETF calls
themselves — useful to confirm the ETF logic works, but doesn't reproduce the
production failure condition.

Usage:
    python3 scripts/test_etf_rate_limit.py [--burst N] [--delay SECONDS] [--pause SECONDS] [--skip-db]

Options:
    --burst N         Fire N rapid stock calls before ETF phase (default: 0;
                      set to ~50 to simulate a real sync depletion)
    --delay SECONDS   Inter-ETF-request delay (default: 3.5)
    --pause SECONDS   Pre-ETF pause after burst (default: 75, mirrors TS code)
    --skip-db         Don't read etf_cycle_summary
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
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

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
    parser.add_argument('--burst', type=int, default=0,
                        help='Number of rapid stock calls to fire before ETF phase (simulates enrichTickers)')
    parser.add_argument('--delay', type=float, default=DEFAULT_DELAY_S,
                        help=f'Inter-ETF-request delay in seconds (default: {DEFAULT_DELAY_S})')
    parser.add_argument('--pause', type=float, default=75.0,
                        help='Pre-ETF pause after burst in seconds (default: 75, mirrors TS code)')
    parser.add_argument('--skip-db', action='store_true', help='Skip DB summary lookup')
    args = parser.parse_args()

    print(f"\n{BOLD}{'='*62}{RESET}")
    print(f"{BOLD}  ETF Yahoo Rate-Limit Test — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}{RESET}")
    print(f"{BOLD}{'='*62}{RESET}")

    # Load watchlist
    with open(WATCHLIST_PATH) as f:
        watchlist = json.load(f)
    tickers = [e['ticker'] for e in watchlist]
    print(f"\n  Watchlist:  {len(tickers)} ETF tickers")
    print(f"  Burst:      {args.burst} stock calls before ETF phase (0 = isolated test)")
    print(f"  Pre-pause:  {args.pause}s after burst before ETF phase")
    print(f"  ETF delay:  {args.delay}s between ETF requests")
    print(f"  Retry:      {MAX_ATTEMPTS} attempts, base backoff {RETRY_BASE_S}s, cooldown {COOLDOWN_S}s")

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

    # --- Phase 1: quota depletion burst (simulates enrichTickers) ---
    if args.burst > 0:
        # Pull a list of S&P 500-ish tickers to use as the burst set
        BURST_TICKERS = [
            'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','JPM','V','UNH',
            'XOM','LLY','JNJ','WMT','MA','AVGO','HD','PG','COST','MRK',
            'ORCL','CVX','BAC','ABBV','CRM','NFLX','AMD','PEP','KO','TMO',
            'ACN','MCD','ABT','CSCO','DHR','ADBE','NKE','TXN','NEE','PM',
            'QCOM','UPS','RTX','INTU','AMGN','SPGI','BLK','GS','AXP','CAT',
        ]
        burst_set = BURST_TICKERS[:args.burst]
        print(f"\n{BOLD}  Phase 1 — Quota depletion ({len(burst_set)} rapid stock calls){RESET}")
        burst_ok = 0
        for i, sym in enumerate(burst_set):
            print(f"  [{i+1:2d}/{len(burst_set)}] {sym:<6s} ", end='', flush=True)
            try:
                info = yf.Ticker(sym).info
                price = info.get('regularMarketPrice') or info.get('currentPrice')
                print(f"{GREEN}ok{RESET} price={price}")
                burst_ok += 1
            except Exception as exc:
                print(f"{RED}err{RESET} {str(exc)[:60]}")
        print(f"\n  Burst done: {burst_ok}/{len(burst_set)} succeeded")

        print(f"\n{BOLD}  Phase 2 — Pre-ETF pause ({args.pause}s){RESET}")
        for remaining in range(int(args.pause), 0, -5):
            print(f"  waiting {remaining}s...", end='\r', flush=True)
            time.sleep(min(5, remaining))
        print(f"  Pause complete.           ")

    print(f"\n{BOLD}  Phase {'3' if args.burst > 0 else '1'} — ETF candidate fetch ({len(tickers)} tickers){RESET}\n")

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
