#!/usr/bin/env python3
"""
cv_utils.py — Shared cross-validation and training utilities.

Provides:
  purged_walk_forward_cv  — purged K-fold with embargo (prevents lookahead bias)
  compute_sample_weights  — exponential recency decay weights
  freshness_guard         — raise ValueError if training data is too stale
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import List, Tuple

import numpy as np
import pandas as pd


def purged_walk_forward_cv(
    df: pd.DataFrame,
    n_folds: int = 5,
    embargo_days: int = 21,
    date_col: str = 'snapshot_date',
) -> List[Tuple[np.ndarray, np.ndarray]]:
    """
    Purged walk-forward CV with embargo gap to prevent lookahead bias.

    Walks forward through n_folds equally-sized validation windows. Each
    training set is capped at embargo_days before the val window starts so
    autocorrelated labels cannot leak across the boundary.

    Returns list of (train_indices, val_indices) numpy arrays (df.index values).
    Folds with empty train or val sets are silently dropped.
    """
    dates = pd.to_datetime(df[date_col])
    all_dates = sorted(dates.unique())
    n_dates = len(all_dates)

    if n_dates < n_folds * 2 + 1:
        raise ValueError(
            f"Too few unique dates ({n_dates}) for {n_folds} folds with embargo. "
            "Reduce n_folds or increase dataset size."
        )

    fold_size = n_dates // (n_folds + 1)
    folds: List[Tuple[np.ndarray, np.ndarray]] = []

    for i in range(n_folds):
        val_start_idx = (i + 1) * fold_size
        val_end_idx = min(val_start_idx + fold_size, n_dates)

        val_start_date = all_dates[val_start_idx]
        val_end_date = all_dates[val_end_idx - 1]

        # Embargo: purge rows within embargo_days before the val window
        embargo_cutoff = pd.Timestamp(val_start_date) - timedelta(days=embargo_days)

        train_mask = dates <= embargo_cutoff
        val_mask = (dates >= val_start_date) & (dates <= val_end_date)

        train_idx = df.index[train_mask].values
        val_idx = df.index[val_mask].values

        if len(train_idx) == 0 or len(val_idx) == 0:
            continue

        folds.append((train_idx, val_idx))

    return folds


def compute_sample_weights(
    df: pd.DataFrame,
    half_life_days: int = 180,
    date_col: str = 'snapshot_date',
) -> np.ndarray:
    """
    Exponential recency decay sample weights.

    w_i = exp(-ln(2) / half_life * days_ago_i), normalized to mean=1.
    More recent rows get higher weight; the half-life controls decay speed.
    """
    dates = pd.to_datetime(df[date_col])
    latest = dates.max()
    days_ago = (latest - dates).dt.days.values.astype(float)

    decay = np.log(2.0) / max(half_life_days, 1)
    weights = np.exp(-decay * days_ago)
    weights = weights / weights.mean()  # normalize so effective N is unchanged
    return weights.astype(np.float32)


def freshness_guard(latest_date, max_staleness_days: int = 60) -> None:
    """
    Raise ValueError if the most recent training snapshot is too old.

    Args:
        latest_date: date, datetime, Timestamp, or ISO string of most recent snapshot
        max_staleness_days: maximum allowed age in calendar days (default 60)

    Raises:
        ValueError with a human-readable message if data is stale.
    """
    if hasattr(latest_date, 'date'):
        latest = latest_date.date()
    elif isinstance(latest_date, str):
        latest = date.fromisoformat(str(latest_date)[:10])
    else:
        latest = latest_date

    staleness = (date.today() - latest).days

    if staleness > max_staleness_days:
        raise ValueError(
            f"Training data is {staleness} days old (latest snapshot: {latest}). "
            f"Threshold is {max_staleness_days} days. "
            "Run build_ranking_dataset.py to refresh snapshots before retraining, "
            "or pass --no-freshness-check to skip this guard."
        )

    print(f"[freshness_guard] Data age: {staleness}d (latest: {latest}, limit: {max_staleness_days}d) ✓")
