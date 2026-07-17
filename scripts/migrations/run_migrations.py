"""
run_migrations.py — Idempotent SQL migration runner.

Iterates *.sql files in this directory in filename order and executes each
statement. Duplicate-column (errno 1060) and duplicate-key (errno 1061)
errors are swallowed so reruns are safe — MySQL 8 does not honor
IF NOT EXISTS on ADD COLUMN / CREATE INDEX, so we detect existence via
information_schema instead.

Usage:
  python3 scripts/migrations/run_migrations.py
  python3 scripts/migrations/run_migrations.py 001_stocks_search_columns.sql
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import mysql.connector
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

if (PROJECT_ROOT / '.env.production').exists():
    load_dotenv(PROJECT_ROOT / '.env.production')
load_dotenv(PROJECT_ROOT / '.env.local', override=True)


def db():
    return mysql.connector.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD'),
        database=os.getenv('DB_DATABASE'),
        port=int(os.getenv('DB_PORT', 3306)),
    )


COL_ADD_RE = re.compile(
    r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b", re.IGNORECASE
)
IDX_RE = re.compile(
    r"CREATE\s+(?:FULLTEXT\s+|UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)", re.IGNORECASE
)


def column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s
        """,
        (table, column),
    )
    rows = cur.fetchall()
    return len(rows) > 0


def index_exists(cur, table: str, index: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s
        """,
        (table, index),
    )
    rows = cur.fetchall()
    return len(rows) > 0


def should_skip(cur, stmt: str) -> tuple[bool, str]:
    m = COL_ADD_RE.search(stmt)
    if m:
        table, col = m.group(1), m.group(2)
        if column_exists(cur, table, col):
            return True, f"column {table}.{col} already exists"
    m = IDX_RE.search(stmt)
    if m:
        idx, table = m.group(1), m.group(2)
        if index_exists(cur, table, idx):
            return True, f"index {table}.{idx} already exists"
    return False, ''


def run_file(path: Path):
    text = path.read_text()
    # Strip -- line comments, then split on semicolons.
    stripped = re.sub(r"--[^\n]*\n", "\n", text)
    statements = [s.strip() for s in stripped.split(';') if s.strip()]

    conn = db()
    # buffered=True — CEXT driver leaves result state around after fetchone(),
    # which triggers "Unread result found" on the next execute().
    cur = conn.cursor(buffered=True)
    try:
        for stmt in statements:
            skip, reason = should_skip(cur, stmt)
            if skip:
                print(f"  [skip] {reason}", file=sys.stderr)
                continue
            try:
                cur.execute(stmt)
                conn.commit()
                print(f"  [ok]   {stmt.split(chr(10))[0][:80]}", file=sys.stderr)
            except mysql.connector.Error as e:
                # 1060 = duplicate column; 1061 = duplicate key. Idempotency net.
                if e.errno in (1060, 1061):
                    print(f"  [skip] {e.msg}", file=sys.stderr)
                else:
                    raise
    finally:
        cur.close()
        conn.close()


def main():
    targets = sys.argv[1:]
    if targets:
        files = [SCRIPT_DIR / t for t in targets]
    else:
        files = sorted(SCRIPT_DIR.glob('*.sql'))

    if not files:
        print("[migrations] no .sql files found", file=sys.stderr)
        return

    for f in files:
        print(f"[migrations] applying {f.name}", file=sys.stderr)
        run_file(f)
    print("[migrations] done", file=sys.stderr)


if __name__ == '__main__':
    main()
