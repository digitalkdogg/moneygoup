import subprocess
import logging
import uuid
import sys
import os
from datetime import datetime
from dotenv import load_dotenv
import mysql.connector
from mysql.connector import Error

# ─────────────────────────────────────────
# Load .env
# ─────────────────────────────────────────
load_dotenv()

# ─────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────

DB_CONFIG = {
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     int(os.getenv("LOG_DB_PORT", 3306)),
    "user":     os.getenv("DB_USER"),
    "password": os.getenv("DB_PASSWORD"),
    "database": os.getenv("LOG_DB_NAME"),
}

APP_NAME    = "moneygoup_deploy"
ENVIRONMENT = os.getenv("ENVIRONMENT", "production")
WORK_DIR    = "/Volume1/www/moneygoup"

# Ordered list of deployment steps: (label, command)
DEPLOY_STEPS = [
    ("git_pull",        ["git", "pull", "origin", "main"]),
    ("sync_script",     ["python3", "deepmoney_sync.py"]),
    ("docker_stop",     ["docker", "stop", "moneygoup"]),
    ("docker_rm",       ["docker", "rm", "moneygoup"]),
    ("docker_build",    ["docker", "build", "-t", "moneygoup", "."]),
    ("docker_run",      ["docker", "run", "-d", "--name", "moneygoup",
                         "-p", "3001:3001", "--env-file", ".env.production", "moneygoup"]),
]

# ─────────────────────────────────────────
# DB Logging Handler
# ─────────────────────────────────────────
class DBHandler(logging.Handler):
    def __init__(self, connection, run_id):
        super().__init__()
        self.conn   = connection
        self.run_id = run_id

    def emit(self, record):
        try:
            self.format(record)
            cursor = self.conn.cursor()
            cursor.execute("""
                INSERT INTO logs.events
                  (app_name, environment, level, logger_name, message,
                   exception_type, exception_message, stack_trace,
                   module, function_name, line_number, run_id, extra)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                APP_NAME,
                ENVIRONMENT,
                record.levelname,
                record.name,
                record.getMessage(),
                type(record.exc_info[1]).__name__ if record.exc_info and record.exc_info[1] else None,
                str(record.exc_info[1])           if record.exc_info and record.exc_info[1] else None,
                record.exc_text,
                record.module,
                record.funcName,
                record.lineno,
                self.run_id,
                None,
            ))
            self.conn.commit()
            cursor.close()
        except Exception as e:
            print(f"[DBHandler] Failed to write log: {e}", file=sys.stderr)


# ─────────────────────────────────────────
# Setup
# ─────────────────────────────────────────
def setup_logger(db_conn, run_id):
    logger = logging.getLogger(APP_NAME)
    logger.setLevel(logging.DEBUG)

    # Console handler
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(console)

    # DB handler
    db_handler = DBHandler(db_conn, run_id)
    db_handler.setLevel(logging.DEBUG)
    logger.addHandler(db_handler)

    return logger


def connect_db():
    # Validate that required env vars were actually loaded
    missing = [k for k, v in DB_CONFIG.items() if v is None]
    if missing:
        print(f"[FATAL] Missing required .env variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except Error as e:
        print(f"[FATAL] Could not connect to log DB: {e}", file=sys.stderr)
        sys.exit(1)


# ─────────────────────────────────────────
# Command Runner
# ─────────────────────────────────────────
def run_step(label, command, logger, cwd=WORK_DIR):
    """
    Runs a single shell command. Returns True on success, False on failure.
    """
    logger.info(f"▶ Starting step [{label}]: {' '.join(command)}")

    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
        )

        if result.stdout.strip():
            logger.info(f"[{label}] stdout: {result.stdout.strip()}")
        if result.stderr.strip():
            logger.warning(f"[{label}] stderr: {result.stderr.strip()}")

        if result.returncode != 0:
            logger.error(
                f"✗ Step [{label}] failed with exit code {result.returncode}. "
                f"stderr: {result.stderr.strip()}"
            )
            return False

        logger.info(f"✔ Step [{label}] completed successfully.")
        return True

    except FileNotFoundError:
        logger.error(f"✗ Step [{label}] failed — command not found: {command[0]}")
        return False
    except Exception as e:
        logger.exception(f"✗ Step [{label}] raised an unexpected exception.")
        return False


# ─────────────────────────────────────────
# Main
# ─────────────────────────────────────────
def main():
    run_id  = str(uuid.uuid4())
    db_conn = connect_db()
    logger  = setup_logger(db_conn, run_id)

    logger.info(f"═══ Deployment started | run_id={run_id} ═══")
    start_time = datetime.now()

    failed_step = None

    for label, command in DEPLOY_STEPS:
        success = run_step(label, command, logger)
        if not success:
            failed_step = label
            break

    duration = (datetime.now() - start_time).total_seconds()

    if failed_step:
        logger.error(
            f"═══ Deployment FAILED at step [{failed_step}] "
            f"after {duration:.1f}s | run_id={run_id} ═══"
        )
    else:
        logger.info(
            f"═══ Deployment COMPLETED successfully "
            f"in {duration:.1f}s | run_id={run_id} ═══"
        )

    db_conn.close()
    sys.exit(1 if failed_step else 0)


if __name__ == "__main__":
    main()