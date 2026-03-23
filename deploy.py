import uuid
import subprocess
import time
from datetime import datetime
import mysql.connector
from mysql.connector import pooling
import os
from dotenv import load_dotenv

# ─────────────────────────────────────────
# Load .env
# ─────────────────────────────────────────
load_dotenv('.env.local', override=False)
load_dotenv('.env.production', override=True)

# ─────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────

DB_CONFIG = {
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     int(os.getenv("LOG_DB_PORT", 3306)),
    "user":     os.getenv("DB_USER"),
    "password": os.getenv("DB_PASSWORD"),
    "database": os.getenv("LOG_DB_NAME"),
    "charset":  "utf8mb4",
}

pool = pooling.MySQLConnectionPool(
    pool_name="deploy_pool",
    pool_size=5,
    **DB_CONFIG
)

MAX_LOG_LENGTH = 4000
DEFAULT_TIMEOUT = 600
RETRY_COUNT = 2

def get_conn():
    return pool.get_connection()

STEPS = [
    {"name": "git_pull", "cmd": "git pull origin main"},
    {"name": "sync_script", "cmd": "python3 deepmoney_sync.py"},
    {"name": "docker_stop", "cmd": "docker stop moneygoup", "ignore_error": True},
    {"name": "docker_rm", "cmd": "docker rm moneygoup", "ignore_error": True},
    {"name": "docker_build", "cmd": "docker build -t moneygoup ."},
    {"name": "docker_run", "cmd": "docker run -d --name moneygoup -p 3001:3001 --env-file .env.production moneygoup"},
]

def create_deployment(conn):
    deployment_id = str(uuid.uuid4())
    cur = conn.cursor()
    cur.execute("INSERT INTO deployments (id) VALUES (%s)", (deployment_id,))
    conn.commit()
    return deployment_id

def create_step(conn, deployment_id, name):
    cur = conn.cursor()
    now = datetime.now()
    cur.execute("""
        INSERT INTO steps (deployment_id, name, status, started_at)
        VALUES (%s, %s, 'running', %s)
    """, (deployment_id, name, now))
    conn.commit()
    return cur.lastrowid, now   

def update_step(conn, step_id, status, start_time):
    cur = conn.cursor()
    end_time = datetime.now()
    duration = int((end_time - start_time).total_seconds() * 1000)

    cur.execute("""
        UPDATE steps
        SET status=%s, finished_at=%s, duration_ms=%s
        WHERE id=%s
    """, (status, end_time, duration, step_id))
    conn.commit()

def log_event(conn, step_id, event_type):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO events (step_id, event_type) VALUES (%s, %s)",
        (step_id, event_type)
    )
    conn.commit()

def log_child(conn, step_id, message, log_type):
    if not message:
        return

    message = message[:MAX_LOG_LENGTH]

    cur = conn.cursor()
    cur.execute(
        "INSERT INTO child_events (step_id, log, log_type) VALUES (%s, %s, %s)",
        (step_id, message, log_type)
    )
    conn.commit()

def run_command(step, deployment_id):
    conn = get_conn()
    step_id, start_time = create_step(conn, deployment_id, step["name"])
    log_event(conn, step_id, "start")

    success = False

    for attempt in range(RETRY_COUNT + 1):
        try:
            process = subprocess.Popen(
                step["cmd"],
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )

            start_exec = time.time()

            while True:
                if process.poll() is not None:
                    break

                if time.time() - start_exec > step.get("timeout", DEFAULT_TIMEOUT):
                    process.kill()
                    raise TimeoutError("Step timed out")

                stdout_line = process.stdout.readline()
                if stdout_line:
                    print(stdout_line.strip())
                    log_child(conn, step_id, stdout_line.strip(), "stdout")

                stderr_line = process.stderr.readline()
                if stderr_line:
                    print(stderr_line.strip())
                    log_child(conn, step_id, stderr_line.strip(), "stderr")

            process.wait()

            for line in process.stdout.readlines():
                log_child(conn, step_id, line.strip(), "stdout")

            for line in process.stderr.readlines():
                log_child(conn, step_id, line.strip(), "stderr")

            if process.returncode == 0:
                success = True
                break
            else:
                raise Exception(f"Exit code {process.returncode}")

        except Exception as e:
            log_child(conn, step_id, str(e), "stderr")

            if attempt < RETRY_COUNT:
                print(f"Retrying {step['name']} (attempt {attempt+1})...")
                time.sleep(2)
            else:
                if step.get("ignore_error"):
                    success = True
                else:
                    success = False

    if success:
        log_event(conn, step_id, "finish")
        update_step(conn, step_id, "success", start_time)
    else:
        log_event(conn, step_id, "error")
        update_step(conn, step_id, "failed", start_time)

    conn.close()
    return success

def run_deployment():
    conn = get_conn()
    deployment_id = create_deployment(conn)
    conn.close()

    print(f"\n🚀 Deployment started: {deployment_id}\n")

    for step in STEPS:
        success = run_command(step, deployment_id)

        if not success:
            print(f"\n❌ Deployment failed at step: {step['name']}")
            return

    print("\n✅ Deployment completed successfully")  

if __name__ == "__main__":
    run_deployment()