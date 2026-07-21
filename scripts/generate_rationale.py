#!/usr/bin/env python3
"""
generate_rationale.py — Standalone async narration worker for the spawn path.

Called non-awaited from route.ts when PREDICTION_SERVICE_URL is not configured
(warm service unavailable).  Reads the already-computed prediction result from
a temp JSON file, generates the LLM narrative, UPDATEs prediction_records, and
deletes the temp file.  Runs entirely outside the prediction semaphore.

Usage (internal — route.ts fires this):
    python3 scripts/generate_rationale.py TICKER --result-file /tmp/narration_xxx.json

Exit codes: 0 on success or graceful failure, 1 on unhandled error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

from dotenv import load_dotenv
if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', '3306'))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('ticker', help='Stock ticker symbol')
    parser.add_argument('--result-file', required=True,
                        help='Path to temp JSON file containing {result, analyst_rating}')
    args = parser.parse_args()

    result_file = Path(args.result_file)
    try:
        payload = json.loads(result_file.read_text())
        result        = payload.get('result', {})
        analyst_rating = payload.get('analyst_rating')
    except Exception as exc:
        print(f'[generate_rationale] Failed to read result file: {exc}', file=sys.stderr)
        return
    finally:
        try:
            result_file.unlink(missing_ok=True)
        except Exception:
            pass

    try:
        from prediction_narrator import build_prediction_rationale
        rationale = build_prediction_rationale(
            args.ticker,
            result,
            feature_ctx={'analyst_rating': analyst_rating},
        )
    except Exception as exc:
        print(f'[generate_rationale] Narrator failed for {args.ticker}: {exc}', file=sys.stderr)
        return

    if not rationale:
        return

    try:
        import mysql.connector
        conn = mysql.connector.connect(
            host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
            database=DB_DATABASE, port=DB_PORT,
        )
        cur = conn.cursor()
        cur.execute(
            'UPDATE prediction_records SET llm_rationale = %s '
            'WHERE symbol = %s ORDER BY predicted_at DESC LIMIT 1',
            (rationale, args.ticker),
        )
        conn.commit()
        cur.close()
        conn.close()
        print(f'[generate_rationale] Updated llm_rationale for {args.ticker}', file=sys.stderr)
    except Exception as exc:
        print(f'[generate_rationale] DB update failed for {args.ticker}: {exc}', file=sys.stderr)


if __name__ == '__main__':
    main()
