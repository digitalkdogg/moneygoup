#!/usr/bin/env python3
"""
check_retrain_coverage.py — Coverage gate for Phase 4 model retrain.

Queries analyst_estimate_history to determine how many tickers have
accumulated >= SNAPSHOT_MIN_DAYS daily snapshots. When either threshold
(absolute count OR universe-percentage) is crossed and hasn't been
triggered before, this script fires retrain_pipeline.py --incremental
and records the trigger event so it doesn't re-fire on subsequent runs.

Thresholds (both checked; first to fire wins):
  COVERAGE_TRIGGER_ABS = 50 tickers  with 30+ snapshots
  COVERAGE_TRIGGER_PCT = 15%  of phase-4-eligible universe

Phase-4-eligible universe = all distinct symbols in analyst_estimate_history.

Usage:
  python3 scripts/check_retrain_coverage.py          # report only
  python3 scripts/check_retrain_coverage.py --fire   # trigger retrain when threshold met
  python3 scripts/check_retrain_coverage.py --reset  # clear prior trigger state (re-arm)

Exit codes:
  0 = below threshold, or already triggered previously
  1 = threshold crossed (retrain fired when --fire given, else just reported)
  2 = error
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
MODELS_DIR   = PROJECT_ROOT / "models"
LOGS_DIR     = PROJECT_ROOT / "logs"
LOGS_DIR.mkdir(exist_ok=True)
MODELS_DIR.mkdir(exist_ok=True)

load_dotenv(PROJECT_ROOT / ".env.production", override=False)
load_dotenv(PROJECT_ROOT / ".env.local", override=True)

DB_HOST     = os.getenv("DB_HOST", "localhost")
DB_USER     = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_DATABASE = os.getenv("DB_DATABASE")
DB_PORT     = int(os.getenv("DB_PORT", 3306))

PYTHON = str(PROJECT_ROOT / "venv" / "bin" / "python3")
if not Path(PYTHON).exists():
    PYTHON = sys.executable

STATE_FILE         = MODELS_DIR / "retrain_coverage_state.json"
SNAPSHOT_MIN_DAYS  = 30    # snapshots a ticker needs to be counted as "covered"
COVERAGE_TRIGGER_ABS = 50  # absolute ticker count trigger
COVERAGE_TRIGGER_PCT = 0.15  # 15% of universe trigger


def setup_logging(quiet: bool) -> logging.Logger:
    fmt = "%(asctime)s  %(levelname)-8s  %(message)s"
    level = logging.WARNING if quiet else logging.INFO
    logging.basicConfig(level=level, format=fmt,
                        handlers=[logging.StreamHandler(sys.stdout)])
    return logging.getLogger("check_retrain_coverage")


def get_db():
    import mysql.connector
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT,
    )


def query_coverage(log: logging.Logger) -> dict:
    """Return coverage stats from analyst_estimate_history."""
    try:
        conn = get_db()
        cur  = conn.cursor()

        cur.execute("""
            SELECT
                COUNT(DISTINCT aeh.symbol)                                      AS universe_size,
                SUM(CASE WHEN t.day_count >= %s THEN 1 ELSE 0 END)             AS covered_tickers,
                MAX(aeh.snapshot_date)                                          AS latest_snapshot,
                MIN(aeh.snapshot_date)                                          AS earliest_snapshot
            FROM analyst_estimate_history aeh
            JOIN (
                SELECT symbol, COUNT(*) AS day_count
                FROM analyst_estimate_history
                GROUP BY symbol
            ) t ON t.symbol = aeh.symbol
        """, (SNAPSHOT_MIN_DAYS,))
        row = cur.fetchone()
        conn.close()

        universe_size     = int(row[0]) if row[0] else 0
        covered_tickers   = int(row[1]) if row[1] else 0
        latest_snapshot   = str(row[2]) if row[2] else "N/A"
        earliest_snapshot = str(row[3]) if row[3] else "N/A"

        coverage_pct = covered_tickers / universe_size if universe_size > 0 else 0.0

        return {
            "universe_size":     universe_size,
            "covered_tickers":   covered_tickers,
            "coverage_pct":      coverage_pct,
            "latest_snapshot":   latest_snapshot,
            "earliest_snapshot": earliest_snapshot,
        }
    except Exception as exc:
        log.error("DB query failed: %s", exc)
        return {}


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


def threshold_crossed(stats: dict) -> tuple[bool, str]:
    """Return (crossed, reason) for the first threshold that fires."""
    n = stats.get("covered_tickers", 0)
    u = stats.get("universe_size", 0)
    p = stats.get("coverage_pct", 0.0)

    if n >= COVERAGE_TRIGGER_ABS:
        return True, f"{n} tickers >= {SNAPSHOT_MIN_DAYS}d (absolute floor {COVERAGE_TRIGGER_ABS})"
    if u > 0 and p >= COVERAGE_TRIGGER_PCT:
        return True, (f"{n}/{u} tickers >= {SNAPSHOT_MIN_DAYS}d "
                      f"({p*100:.1f}% >= {COVERAGE_TRIGGER_PCT*100:.0f}% threshold)")
    return False, ""


def fire_retrain(log: logging.Logger) -> bool:
    """Invoke retrain_pipeline.py --incremental. Return True on success."""
    cmd = [PYTHON, str(SCRIPT_DIR / "retrain_pipeline.py"), "--incremental"]
    log.info("Firing retrain: %s", " ".join(cmd))
    try:
        result = subprocess.run(cmd, cwd=str(SCRIPT_DIR), timeout=7200)
        log.info("retrain_pipeline exit code: %d", result.returncode)
        return result.returncode in (0, 1)  # 0=promoted, 1=kept champ, both valid
    except Exception as exc:
        log.error("Failed to launch retrain_pipeline: %s", exc)
        return False


def print_coverage_summary(stats: dict, state: dict) -> None:
    n = stats.get("covered_tickers", 0)
    u = stats.get("universe_size", 0)
    p = stats.get("coverage_pct", 0.0)
    abs_pct  = n / COVERAGE_TRIGGER_ABS * 100
    univ_pct = p / COVERAGE_TRIGGER_PCT * 100 if COVERAGE_TRIGGER_PCT > 0 else 0
    bar_len  = 30

    def bar(filled_pct: float) -> str:
        filled = min(int(bar_len * filled_pct / 100), bar_len)
        return "[" + "#" * filled + "." * (bar_len - filled) + "]"

    print()
    print("  PHASE-4 RETRAIN COVERAGE GATE")
    print(f"    Universe (analyst_estimate_history): {u} tickers")
    print(f"    With >={SNAPSHOT_MIN_DAYS} snapshots:              {n} tickers")
    print(f"    Date range:                          {stats.get('earliest_snapshot')} → {stats.get('latest_snapshot')}")
    print()
    print(f"    Absolute floor  ({COVERAGE_TRIGGER_ABS} tickers):    "
          f"{bar(abs_pct)}  {n}/{COVERAGE_TRIGGER_ABS}")
    print(f"    Universe pct    ({COVERAGE_TRIGGER_PCT*100:.0f}% of {u}):  "
          f"{bar(univ_pct)}  {n}/{int(u*COVERAGE_TRIGGER_PCT)} needed  ({p*100:.1f}%)")

    triggered_at = state.get("triggered_at")
    if triggered_at:
        print()
        print(f"    ** Retrain already triggered: {triggered_at} **")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--fire",  action="store_true",
                   help="Launch retrain_pipeline.py when threshold is met")
    p.add_argument("--reset", action="store_true",
                   help="Clear prior trigger state so the gate re-arms")
    p.add_argument("--quiet", action="store_true",
                   help="Suppress INFO logs; only print the summary block")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    log  = setup_logging(args.quiet)

    if args.reset:
        state = load_state()
        state.pop("triggered_at", None)
        state.pop("trigger_reason", None)
        save_state(state)
        log.info("Coverage trigger state reset — gate re-armed")

    stats = query_coverage(log)
    if not stats:
        sys.exit(2)

    state = load_state()
    print_coverage_summary(stats, state)

    crossed, reason = threshold_crossed(stats)

    if not crossed:
        log.info("Coverage below threshold — no action")
        sys.exit(0)

    if state.get("triggered_at"):
        log.info("Threshold crossed, but retrain was already triggered on %s — skipping",
                 state["triggered_at"])
        sys.exit(0)

    # Threshold newly crossed
    print()
    print(f"  *** COVERAGE THRESHOLD MET: {reason} ***")

    if args.fire:
        print("  Launching retrain_pipeline.py --incremental ...")
        ok = fire_retrain(log)
        state["triggered_at"]   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state["trigger_reason"] = reason
        state["retrain_ok"]     = ok
        save_state(state)
        if ok:
            print("  retrain_pipeline completed — check logs/retrain_*.log for results")
        else:
            print("  retrain_pipeline returned a non-zero exit — check logs")
    else:
        print("  Run with --fire to trigger retrain_pipeline.py --incremental")

    sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[check_retrain_coverage] Interrupted", file=sys.stderr)
        sys.exit(2)
