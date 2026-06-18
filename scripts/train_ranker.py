#!/usr/bin/env python3
"""
Train the cross-sectional ranking model (Step 2 of the deepmoney_sync
ranker revamp).

Reads (date, ticker, features_json, forward_return_rank_pct) rows from
`ranking_training_snapshots`, time-splits 80/20 by date so the validation
window is strictly out-of-time, and trains two LightGBM models:

  1. `objective="regression"` on `forward_return_rank_pct` — easier to
     debug, used to sanity-check the pipeline.
  2. `objective="lambdarank"` with rank-pct discretized to integer grades
     (0–4) — the production ranker.

Both are benchmarked against naive baselines (random, momentum, low-vol,
blend) on the same validation window. The model needs to beat the best
baseline on out-of-time Spearman / NDCG@20 to be worth gating Tier-2
Monte Carlo behind it.

Outputs:
  - models/ranker_v1_regression.txt    (LightGBM Booster, regression)
  - models/ranker_v1_lambdarank.txt    (LightGBM Booster, lambdarank)
  - models/feature_manifest.json       (column order + dataset metadata)
  - stdout summary table comparing model vs. each baseline

USAGE:
  python scripts/train_ranker.py
      [--feature-set-version green_v1]
      [--horizon 20]
      [--val-frac 0.2]
      [--top-k 20]
      [--seed 42]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

try:
    import lightgbm as lgb
except ImportError:
    print(
        "ERROR: lightgbm is not installed.\n"
        "  Install with:  pip install lightgbm\n"
        "  (added to requirements.txt for offline ranker training)",
        file=sys.stderr,
    )
    sys.exit(1)

from scipy.stats import spearmanr
import mysql.connector
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env.local")

MODELS_DIR = PROJECT_ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)


def _clean(s: Optional[str]) -> str:
    return (s or "").strip().strip('"').strip("'")


def db_conn() -> mysql.connector.MySQLConnection:
    return mysql.connector.connect(
        host=_clean(os.environ.get("DB_HOST")),
        port=int(_clean(os.environ.get("DB_PORT")) or 3306),
        user=_clean(os.environ.get("DB_USER")),
        password=_clean(os.environ.get("DB_PASSWORD")),
        database=_clean(os.environ.get("DB_DATABASE")),
    )


# ─── Data loading ───────────────────────────────────────────────────────────
def load_dataset(feature_set_version: str, horizon: int) -> pd.DataFrame:
    """Pull all snapshots and unpack features_json into a flat DataFrame."""
    conn = db_conn()
    cur = conn.cursor(dictionary=True)
    cur.execute(
        """
        SELECT snapshot_date, ticker, forward_return, forward_return_rank_pct, features_json
        FROM ranking_training_snapshots
        WHERE feature_set_version = %s AND horizon_days = %s
          AND forward_return IS NOT NULL
          AND forward_return_rank_pct IS NOT NULL
        ORDER BY snapshot_date, ticker
        """,
        (feature_set_version, horizon),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    if not rows:
        raise RuntimeError(
            f"No rows found for feature_set_version={feature_set_version} horizon={horizon}"
        )

    # Parse features_json column once
    feats = [json.loads(r["features_json"]) if isinstance(r["features_json"], str) else r["features_json"] for r in rows]
    feats_df = pd.DataFrame(feats)
    meta_df = pd.DataFrame(
        {
            "snapshot_date": [r["snapshot_date"] for r in rows],
            "ticker": [r["ticker"] for r in rows],
            "forward_return": [float(r["forward_return"]) for r in rows],
            "forward_return_rank_pct": [float(r["forward_return_rank_pct"]) for r in rows],
        }
    )
    df = pd.concat([meta_df, feats_df], axis=1)
    df["snapshot_date"] = pd.to_datetime(df["snapshot_date"])
    return df


def time_split(df: pd.DataFrame, val_frac: float) -> Tuple[pd.DataFrame, pd.DataFrame, List[pd.Timestamp], List[pd.Timestamp]]:
    """Split by date so validation is strictly later than training."""
    dates = sorted(df["snapshot_date"].unique())
    n_val = max(1, int(round(len(dates) * val_frac)))
    train_dates = dates[:-n_val]
    val_dates = dates[-n_val:]
    train_df = df[df["snapshot_date"].isin(train_dates)].reset_index(drop=True)
    val_df = df[df["snapshot_date"].isin(val_dates)].reset_index(drop=True)
    return train_df, val_df, train_dates, val_dates


# ─── Metrics ────────────────────────────────────────────────────────────────
def per_date_spearman(scores: np.ndarray, df: pd.DataFrame) -> float:
    """Average Spearman correlation between predicted score and forward return,
    computed within each snapshot date and then averaged across dates."""
    correlations = []
    for _, group in df.groupby("snapshot_date"):
        idx = group.index.values
        if len(idx) < 2:
            continue
        rho, _ = spearmanr(scores[idx], group["forward_return"].values)
        if pd.notna(rho):
            correlations.append(rho)
    return float(np.mean(correlations)) if correlations else float("nan")


def per_date_ndcg(scores: np.ndarray, df: pd.DataFrame, k: int) -> float:
    """Mean NDCG@k where relevance = forward_return_rank_pct (0..1) within
    each date's cross-section."""
    ndcgs = []
    for _, group in df.groupby("snapshot_date"):
        idx = group.index.values
        if len(idx) < k:
            continue
        relevance = group["forward_return_rank_pct"].values
        s = scores[idx]
        order = np.argsort(-s)
        top_k_rel = relevance[order[:k]]
        # DCG with log2(i+2) discount
        discounts = 1.0 / np.log2(np.arange(k) + 2)
        dcg = float(np.sum(top_k_rel * discounts))
        ideal_rel = np.sort(relevance)[::-1][:k]
        idcg = float(np.sum(ideal_rel * discounts))
        if idcg > 0:
            ndcgs.append(dcg / idcg)
    return float(np.mean(ndcgs)) if ndcgs else float("nan")


def per_date_precision_at_k(scores: np.ndarray, df: pd.DataFrame, k: int) -> float:
    """Fraction of top-k predicted that also land in the actual top-k by
    forward return, averaged per date."""
    precisions = []
    for _, group in df.groupby("snapshot_date"):
        idx = group.index.values
        if len(idx) < k:
            continue
        ret = group["forward_return"].values
        s = scores[idx]
        actual_top = set(np.argsort(-ret)[:k])
        pred_top = set(np.argsort(-s)[:k])
        precisions.append(len(actual_top & pred_top) / k)
    return float(np.mean(precisions)) if precisions else float("nan")


# ─── Models ─────────────────────────────────────────────────────────────────
def feature_columns(df: pd.DataFrame) -> List[str]:
    non_feature = {
        "snapshot_date", "ticker", "forward_return", "forward_return_rank_pct",
    }
    return [c for c in df.columns if c not in non_feature]


def clean_features(df: pd.DataFrame, cols: List[str]) -> pd.DataFrame:
    """Replace inf with NaN; LightGBM handles NaN natively."""
    x = df[cols].copy()
    x = x.replace([np.inf, -np.inf], np.nan)
    return x


def train_regression(
    train_df: pd.DataFrame, val_df: pd.DataFrame, cols: List[str], seed: int
) -> lgb.Booster:
    x_tr = clean_features(train_df, cols)
    y_tr = train_df["forward_return_rank_pct"].values
    x_va = clean_features(val_df, cols)
    y_va = val_df["forward_return_rank_pct"].values

    dtrain = lgb.Dataset(x_tr, label=y_tr, free_raw_data=False)
    dval = lgb.Dataset(x_va, label=y_va, reference=dtrain, free_raw_data=False)

    params = dict(
        objective="regression",
        metric="rmse",
        learning_rate=0.05,
        num_leaves=63,
        feature_fraction=0.85,
        bagging_fraction=0.85,
        bagging_freq=5,
        min_data_in_leaf=50,
        verbose=-1,
        seed=seed,
    )

    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=800,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(period=0)],
    )
    return booster


def train_lambdarank(
    train_df: pd.DataFrame, val_df: pd.DataFrame, cols: List[str], seed: int
) -> lgb.Booster:
    # Discretize rank-pct into 5 graded relevance bins (0..4)
    def grade(rank_pct: np.ndarray) -> np.ndarray:
        return np.clip(np.floor(rank_pct * 5).astype(int), 0, 4)

    x_tr = clean_features(train_df, cols)
    y_tr = grade(train_df["forward_return_rank_pct"].values)
    x_va = clean_features(val_df, cols)
    y_va = grade(val_df["forward_return_rank_pct"].values)

    grp_tr = train_df.groupby("snapshot_date", sort=False).size().values
    grp_va = val_df.groupby("snapshot_date", sort=False).size().values

    dtrain = lgb.Dataset(x_tr, label=y_tr, group=grp_tr, free_raw_data=False)
    dval = lgb.Dataset(x_va, label=y_va, group=grp_va, reference=dtrain, free_raw_data=False)

    params = dict(
        objective="lambdarank",
        metric="ndcg",
        # NDCG@20 first so LightGBM's early-stopping uses the less-noisy
        # metric. NDCG@5 with ~470 candidates per snapshot is too jittery
        # and was triggering early-stop at iteration 1.
        ndcg_eval_at=[20, 100, 50, 5],
        first_metric_only=True,
        learning_rate=0.05,
        num_leaves=63,
        feature_fraction=0.85,
        bagging_fraction=0.85,
        bagging_freq=5,
        min_data_in_leaf=50,
        lambdarank_truncation_level=100,
        verbose=-1,
        seed=seed,
    )

    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=800,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(period=0)],
    )
    return booster


# ─── Baselines ──────────────────────────────────────────────────────────────
def baseline_scores(df: pd.DataFrame, name: str, seed: int) -> np.ndarray:
    """Naive ranking signals to compare against. All clipped/standardized so
    higher score => predicted to outperform."""
    if name == "random":
        rng = np.random.default_rng(seed)
        return rng.random(len(df))
    if name == "momentum_12m":
        return df["ROC_12m"].fillna(0).values
    if name == "low_volatility":
        return -df["HistVol_30"].fillna(df["HistVol_30"].median()).values
    if name == "rs_vs_spy":
        return df["RS_vs_SPY_20d"].fillna(0).values
    if name == "blend":
        mom = df["ROC_12m"].fillna(0).rank(pct=True).values
        rs = df["RS_vs_SPY_20d"].fillna(0).rank(pct=True).values
        vol = (-df["HistVol_30"]).fillna((-df["HistVol_30"]).median()).rank(pct=True).values
        return (mom + rs + vol) / 3.0
    raise ValueError(f"Unknown baseline: {name}")


# ─── Main ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--feature-set-version", default="green_v1")
    ap.add_argument("--horizon", type=int, default=20)
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument(
        "--top-k",
        default="20,100",
        help="Comma-separated K values for NDCG@K and precision@K reporting "
             "(default '20,100'). 100 is the gating-decision target.",
    )
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    print(f"[load] feature_set_version={args.feature_set_version} horizon={args.horizon}", file=sys.stderr)
    df = load_dataset(args.feature_set_version, args.horizon)
    print(f"[load] {len(df):,} rows, {df['ticker'].nunique()} tickers, {df['snapshot_date'].nunique()} dates", file=sys.stderr)

    train_df, val_df, train_dates, val_dates = time_split(df, args.val_frac)
    print(
        f"[split] train {len(train_df):,} rows ({len(train_dates)} dates {train_dates[0].date()}→{train_dates[-1].date()}), "
        f"val {len(val_df):,} rows ({len(val_dates)} dates {val_dates[0].date()}→{val_dates[-1].date()})",
        file=sys.stderr,
    )

    cols = feature_columns(df)
    print(f"[features] {len(cols)} columns", file=sys.stderr)

    # Train both objectives
    print("\n[train] regression on forward_return_rank_pct ...", file=sys.stderr)
    reg = train_regression(train_df, val_df, cols, args.seed)
    reg_scores_val = reg.predict(clean_features(val_df, cols))

    print("\n[train] lambdarank with rank-pct grades ...", file=sys.stderr)
    rank = train_lambdarank(train_df, val_df, cols, args.seed)
    rank_scores_val = rank.predict(clean_features(val_df, cols))

    # Baselines
    baselines = ["random", "momentum_12m", "low_volatility", "rs_vs_spy", "blend"]
    base_scores_val = {b: baseline_scores(val_df, b, args.seed) for b in baselines}

    # Evaluate at multiple K values; sort by ndcg@K_sort_by for display.
    eval_ks: List[int] = sorted({int(k) for k in args.top_k.split(",") if k.strip()})
    k_sort_by = eval_ks[-1] if 100 in eval_ks else eval_ks[0]

    def eval_row(name: str, scores: np.ndarray) -> Dict[str, float]:
        row: Dict[str, float] = {"model": name, "spearman": per_date_spearman(scores, val_df)}
        for k in eval_ks:
            row[f"ndcg@{k}"] = per_date_ndcg(scores, val_df, k)
            row[f"precision@{k}"] = per_date_precision_at_k(scores, val_df, k)
        return row

    results: List[Dict[str, float]] = [
        eval_row("LightGBM regression", reg_scores_val),
        eval_row("LightGBM lambdarank", rank_scores_val),
    ]
    for b in baselines:
        results.append(eval_row(f"baseline:{b}", base_scores_val[b]))

    # Print summary
    col_w = 28
    metric_cols = ["spearman"] + [m for k in eval_ks for m in (f"ndcg@{k}", f"prec@{k}")]
    header = f"{'model':<{col_w}}" + "".join(f"{c:>12}" for c in metric_cols)
    width = col_w + 12 * len(metric_cols)
    print("\n" + "=" * width)
    print(f"OUT-OF-TIME VALIDATION ({len(val_dates)} dates, sorted by ndcg@{k_sort_by})")
    print("=" * width)
    print(header)
    print("-" * width)
    for row in sorted(results, key=lambda r: r[f"ndcg@{k_sort_by}"], reverse=True):
        line = f"{row['model']:<{col_w}}"
        line += f"{row['spearman']:>12.4f}"
        for k in eval_ks:
            line += f"{row[f'ndcg@{k}']:>12.4f}"
            line += f"{row[f'precision@{k}']:>12.4f}"
        print(line)
    print("=" * width)

    # Save artifacts
    reg_path = MODELS_DIR / "ranker_v1_regression.txt"
    rank_path = MODELS_DIR / "ranker_v1_lambdarank.txt"
    reg.save_model(str(reg_path))
    rank.save_model(str(rank_path))

    manifest = {
        "feature_set_version": args.feature_set_version,
        "horizon": args.horizon,
        "feature_columns": cols,
        "trained_at": date.today().isoformat(),
        "train_rows": int(len(train_df)),
        "val_rows": int(len(val_df)),
        "train_date_range": [train_dates[0].date().isoformat(), train_dates[-1].date().isoformat()],
        "val_date_range": [val_dates[0].date().isoformat(), val_dates[-1].date().isoformat()],
        "eval_ks": eval_ks,
        "metrics": {row["model"]: {k: v for k, v in row.items() if k != "model"} for row in results},
    }
    (MODELS_DIR / "feature_manifest.json").write_text(json.dumps(manifest, indent=2))

    print(f"\n[saved] {reg_path}", file=sys.stderr)
    print(f"[saved] {rank_path}", file=sys.stderr)
    print(f"[saved] {MODELS_DIR / 'feature_manifest.json'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
