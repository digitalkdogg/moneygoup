#!/usr/bin/env python3
"""
retrain_pipeline.py — Orchestrates the full model retrain cycle.

Runs build_ranking_dataset.py (incremental snapshot refresh), trains
short-term CS and ranker models, applies a champion/challenger gate,
and only promotes new artifacts if they beat the deployed model by a
required margin.

Exit codes:
  0 = success, new model promoted (or dry-run completed)
  1 = challenger lost, champion retained
  2 = error (build or training failure)

Usage:
  python3 scripts/retrain_pipeline.py --target all --incremental
  python3 scripts/retrain_pipeline.py --target short_term --dry-run
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
MODELS_DIR   = PROJECT_ROOT / "models"
LOGS_DIR     = PROJECT_ROOT / "logs"
LOGS_DIR.mkdir(exist_ok=True)
MODELS_DIR.mkdir(exist_ok=True)

# ── Env loading (same pattern as train_short_term_cs.py) ──────────────────────
if (PROJECT_ROOT / ".env.production").exists():
    load_dotenv(PROJECT_ROOT / ".env.production")
load_dotenv(PROJECT_ROOT / ".env.local", override=True)

DB_HOST     = os.getenv("DB_HOST", "localhost")
DB_USER     = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_DATABASE = os.getenv("DB_DATABASE")
DB_PORT     = int(os.getenv("DB_PORT", 3306))

PYTHON = str(PROJECT_ROOT / "venv" / "bin" / "python3")

# ── Gating thresholds ─────────────────────────────────────────────────────────
ST_DIR_MIN_DELTA    = 0.005   # 0.5 pp improvement required on 5d or 21d dir accuracy
RANKER_SPEARMAN_MIN = 0.010   # 1.0 pp improvement required on lambdarank spearman


# ── Logging setup ─────────────────────────────────────────────────────────────

def setup_logging() -> logging.Logger:
    log_file = LOGS_DIR / f"retrain_{datetime.now().strftime('%Y%m%d')}.log"
    fmt = "%(asctime)s  %(levelname)-8s  %(message)s"
    logging.basicConfig(
        level=logging.INFO,
        format=fmt,
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(log_file, encoding="utf-8"),
        ],
    )
    return logging.getLogger("retrain_pipeline")


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Orchestrate full model retrain cycle with champion/challenger gating.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--target",
        choices=["all", "short_term", "ranker", "long_term"],
        default="all",
        help="Which model(s) to retrain (default: all)",
    )
    p.add_argument(
        "--incremental",
        action="store_true",
        help="Only build snapshots since the last snapshot date",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Run all steps but don't overwrite model artifacts",
    )
    p.add_argument(
        "--no-freshness-check",
        action="store_true",
        help="Pass --no-freshness-check to training scripts",
    )
    p.add_argument(
        "--feature-set",
        default="green_v3",
        help="Feature set version for training (default: green_v3)",
    )
    return p.parse_args()


# ── Subprocess helper ─────────────────────────────────────────────────────────

def run_step(
    cmd_list: list[str],
    step_name: str,
    log: logging.Logger,
) -> tuple[bool, str, str]:
    """Run a subprocess, stream output to log, return (success, stdout, stderr)."""
    log.info("=== STEP: %s ===", step_name)
    log.info("CMD: %s", " ".join(cmd_list))
    try:
        proc = subprocess.Popen(
            cmd_list,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(SCRIPT_DIR),
        )
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        # Stream stdout
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\n")
            log.info("[%s] %s", step_name, line)
            stdout_lines.append(line)

        proc.wait()

        # Collect stderr
        assert proc.stderr is not None
        for line in proc.stderr:
            line = line.rstrip("\n")
            if line:
                log.warning("[%s STDERR] %s", step_name, line)
                stderr_lines.append(line)

        stdout = "\n".join(stdout_lines)
        stderr = "\n".join(stderr_lines)

        if proc.returncode != 0:
            log.error("STEP FAILED: %s (exit code %d)", step_name, proc.returncode)
            return False, stdout, stderr

        log.info("STEP OK: %s", step_name)
        return True, stdout, stderr

    except Exception as exc:
        log.exception("STEP ERROR: %s — %s", step_name, exc)
        return False, "", str(exc)


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_db():
    import mysql.connector
    return mysql.connector.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_DATABASE,
        port=DB_PORT,
    )


def get_last_snapshot_date(log: logging.Logger) -> str | None:
    """Query DB for MAX(snapshot_date) in ranking_training_snapshots."""
    try:
        conn = get_db()
        cur  = conn.cursor()
        cur.execute("SELECT MAX(snapshot_date) FROM ranking_training_snapshots")
        row = cur.fetchone()
        conn.close()
        if row and row[0]:
            date_str = str(row[0])
            log.info("Last snapshot date: %s", date_str)
            return date_str
        log.warning("No snapshot dates found in ranking_training_snapshots")
        return None
    except Exception as exc:
        log.warning("Could not query last snapshot date: %s", exc)
        return None


# ── Champion metrics ──────────────────────────────────────────────────────────

def load_champion_metrics(log: logging.Logger) -> dict | None:
    """
    Read models/feature_manifest.json for ranker spearman, and
    models/short_term_cs_v1.pkl for direction accuracy metrics.
    Returns None if artifacts don't exist.
    """
    metrics: dict = {}

    manifest_path = MODELS_DIR / "feature_manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
            lambdarank = manifest.get("metrics", {}).get("LightGBM lambdarank", {})
            metrics["ranker_spearman"] = lambdarank.get("spearman")
            log.info("Champion ranker spearman: %s", metrics["ranker_spearman"])
        except Exception as exc:
            log.warning("Could not load feature_manifest.json: %s", exc)
    else:
        log.warning("feature_manifest.json not found — no champion ranker metrics")

    # Prefer v1 pkl (the active champion)
    for pkl_name in ("short_term_cs_v1.pkl",):
        pkl_path = MODELS_DIR / pkl_name
        if pkl_path.exists():
            try:
                import joblib
                artifact = joblib.load(pkl_path)
                m = artifact.get("metrics", {})
                metrics["st_dir_5d"]  = m.get("direction_accuracy_5d")
                metrics["st_dir_21d"] = m.get("direction_accuracy_21d")
                log.info(
                    "Champion ST metrics — dir_5d=%s  dir_21d=%s",
                    metrics["st_dir_5d"],
                    metrics["st_dir_21d"],
                )
            except Exception as exc:
                log.warning("Could not load %s: %s", pkl_name, exc)
            break
    else:
        log.warning("No short_term_cs pkl found — no champion ST metrics")

    return metrics if metrics else None


# ── Metric extraction from stdout ─────────────────────────────────────────────

def extract_st_metrics(stdout: str, log: logging.Logger) -> dict:
    """Pull direction_accuracy_5d / direction_accuracy_21d from training output."""
    result: dict = {}
    for key, pattern in [
        ("st_dir_5d",  r"direction_accuracy_5d[=:\s]+([0-9.]+)"),
        ("st_dir_21d", r"direction_accuracy_21d[=:\s]+([0-9.]+)"),
    ]:
        m = re.search(pattern, stdout, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            # Normalise to [0,1] if expressed as percentage
            result[key] = val / 100.0 if val > 1.5 else val
            log.info("Challenger %s: %.4f", key, result[key])
        else:
            log.warning("Could not extract %s from training output", key)
    return result


def extract_ranker_spearman(stdout: str, log: logging.Logger) -> dict:
    """Pull spearman from the LightGBM lambdarank row in the printed table."""
    result: dict = {}
    # Match line like: "LightGBM lambdarank  |  0.1389  |  ..."
    m = re.search(
        r"LightGBM\s+lambdarank[^\n]*?([+-]?[0-9]+\.[0-9]+)",
        stdout,
        re.IGNORECASE,
    )
    if m:
        result["ranker_spearman"] = float(m.group(1))
        log.info("Challenger ranker spearman: %.6f", result["ranker_spearman"])
    else:
        log.warning("Could not extract lambdarank spearman from ranker output")
    return result


# ── Metrics diff table ────────────────────────────────────────────────────────

def print_metrics_table(
    champion: dict | None,
    challenger: dict,
    log: logging.Logger,
) -> None:
    champ = champion or {}

    def fmt_pct(v) -> str:
        if v is None:
            return "   N/A  "
        return f"{v*100:6.2f}%"

    def fmt_sp(v) -> str:
        if v is None:
            return "   N/A  "
        return f"{v:8.4f}"

    def delta_pct(c, ch) -> str:
        if c is None or ch is None:
            return "   N/A  "
        d = (ch - c) * 100
        return f"{d:+6.2f}%"

    def delta_sp(c, ch) -> str:
        if c is None or ch is None:
            return "   N/A  "
        d = ch - c
        return f"{d:+8.4f}"

    c_5d    = champ.get("st_dir_5d")
    h_5d    = challenger.get("st_dir_5d")
    c_21d   = champ.get("st_dir_21d")
    h_21d   = challenger.get("st_dir_21d")
    c_sp    = champ.get("ranker_spearman")
    h_sp    = challenger.get("ranker_spearman")

    lines = [
        "┌─────────────────────────┬──────────────┬──────────────┬──────────┐",
        "│ Metric                  │ Champion     │ Challenger   │ Delta    │",
        "├─────────────────────────┼──────────────┼──────────────┼──────────┤",
        f"│ ST dir_acc_5d           │ {fmt_pct(c_5d):12s} │ {fmt_pct(h_5d):12s} │ {delta_pct(c_5d, h_5d):8s} │",
        f"│ ST dir_acc_21d          │ {fmt_pct(c_21d):12s} │ {fmt_pct(h_21d):12s} │ {delta_pct(c_21d, h_21d):8s} │",
        f"│ Ranker spearman         │ {fmt_sp(c_sp):12s} │ {fmt_sp(h_sp):12s} │ {delta_sp(c_sp, h_sp):8s} │",
        "└─────────────────────────┴──────────────┴──────────────┴──────────┘",
    ]
    table = "\n".join(lines)
    print(table)
    log.info("\n%s", table)


# ── Gate logic ────────────────────────────────────────────────────────────────

def challenger_beats_champion(
    champion: dict | None,
    challenger: dict,
    target: str,
    log: logging.Logger,
) -> bool:
    """Return True if challenger clears the promotion threshold."""
    if champion is None:
        log.info("No champion metrics found — challenger auto-promotes")
        return True

    wins: list[bool] = []

    if target in ("all", "short_term"):
        c5  = champion.get("st_dir_5d")
        h5  = challenger.get("st_dir_5d")
        c21 = champion.get("st_dir_21d")
        h21 = challenger.get("st_dir_21d")
        if h5 is not None and c5 is not None:
            wins.append((h5 - c5) >= ST_DIR_MIN_DELTA)
        if h21 is not None and c21 is not None:
            wins.append((h21 - c21) >= ST_DIR_MIN_DELTA)

    if target in ("all", "ranker"):
        c_sp = champion.get("ranker_spearman")
        h_sp = challenger.get("ranker_spearman")
        if h_sp is not None and c_sp is not None:
            wins.append((h_sp - c_sp) >= RANKER_SPEARMAN_MIN)

    if not wins:
        log.warning("No comparable metrics available — defaulting to keep champion")
        return False

    result = any(wins)
    log.info("Gate result: %s (wins=%s)", "PROMOTE" if result else "KEEP CHAMPION", wins)
    return result


# ── Promotion / rollback ──────────────────────────────────────────────────────

def promote_challenger(log: logging.Logger) -> None:
    """Backup champion and move v2 → v1 (active)."""
    v1  = MODELS_DIR / "short_term_cs_v1.pkl"
    v2  = MODELS_DIR / "short_term_cs_v2.pkl"
    bak = MODELS_DIR / "short_term_cs_v1.bak.pkl"

    if v1.exists():
        shutil.copy2(str(v1), str(bak))
        log.info("Backed up champion to %s", bak)

    if v2.exists():
        shutil.copy2(str(v2), str(v1))
        log.info("Promoted challenger v2 → v1 (active)")
    else:
        log.warning("short_term_cs_v2.pkl not found; v1 unchanged")

    # Update trained_at in feature_manifest
    manifest_path = MODELS_DIR / "feature_manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
            manifest["trained_at"] = datetime.now().strftime("%Y-%m-%d")
            manifest_path.write_text(json.dumps(manifest, indent=2))
            log.info("Updated feature_manifest.json trained_at")
        except Exception as exc:
            log.warning("Could not update feature_manifest.json: %s", exc)


def cleanup_challenger(log: logging.Logger) -> None:
    """Remove v2 artifact so stale challenger doesn't pollute next run."""
    v2 = MODELS_DIR / "short_term_cs_v2.pkl"
    if v2.exists():
        v2.unlink()
        log.info("Removed challenger artifact short_term_cs_v2.pkl")


# ── Main pipeline ─────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()
    log  = setup_logging()

    log.info("=== retrain_pipeline START  target=%s  incremental=%s  dry_run=%s ===",
             args.target, args.incremental, args.dry_run)

    challenger_metrics: dict = {}

    # ── Step 1: Build snapshots ────────────────────────────────────────────────
    if args.target in ("all", "short_term", "ranker"):
        cmd = [PYTHON, str(SCRIPT_DIR.parent / "build_ranking_dataset.py")]
        if args.incremental:
            last_date = get_last_snapshot_date(log)
            if last_date:
                cmd += ["--start", last_date]
                log.info("Incremental build from %s", last_date)
            else:
                log.warning("--incremental requested but no last date found; building all")
        ok, _, _ = run_step(cmd, "build_snapshots", log)
        if not ok:
            log.error("Snapshot build failed — aborting pipeline")
            sys.exit(2)

    # ── Step 2: Train short-term CS ────────────────────────────────────────────
    if args.target in ("all", "short_term"):
        cmd = [
            PYTHON, "train_short_term_cs.py",
            "--version", "v2",
            "--cv",
            "--feature-set", args.feature_set,
        ]
        if args.no_freshness_check:
            cmd.append("--no-freshness-check")
        ok, stdout, _ = run_step(cmd, "train_short_term_cs", log)
        if not ok:
            log.error("Short-term CS training failed — aborting pipeline")
            sys.exit(2)
        challenger_metrics.update(extract_st_metrics(stdout, log))

    # ── Step 3: Train ranker ───────────────────────────────────────────────────
    if args.target in ("all", "ranker"):
        cmd = [
            PYTHON, "train_ranker.py",
            "--feature-set-version", args.feature_set,
        ]
        ok, stdout, _ = run_step(cmd, "train_ranker", log)
        if not ok:
            log.error("Ranker training failed — aborting pipeline")
            sys.exit(2)
        challenger_metrics.update(extract_ranker_spearman(stdout, log))

    # long_term target: placeholder — extend here when long-term retrain exists
    if args.target == "long_term":
        log.warning("long_term retrain not yet implemented; nothing to do")
        sys.exit(0)

    # ── Step 4: Champion/challenger gate ───────────────────────────────────────
    champion_metrics = load_champion_metrics(log)
    print_metrics_table(champion_metrics, challenger_metrics, log)

    promote = challenger_beats_champion(champion_metrics, challenger_metrics, args.target, log)

    if args.dry_run:
        if promote:
            log.info("DRY RUN: would have promoted challenger")
        else:
            log.info("DRY RUN: would have kept champion")
        sys.exit(0)

    if promote:
        promote_challenger(log)
        log.info("PROMOTED: challenger beat champion — new model is live")
        sys.exit(0)
    else:
        log.info("KEPT CHAMPION: challenger did not beat by required margin")
        cleanup_challenger(log)
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[retrain_pipeline] Interrupted by user", file=sys.stderr)
        sys.exit(2)
