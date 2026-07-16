#!/usr/bin/env python3
"""
Online inference for the cross-sectional ranker (Step 3, Path A).

Reads a batch payload of {snapshot_date, candidates: [{ticker, payload}, ...]}
from stdin (or --input-file), computes the GREEN feature vector for each
ticker, scores them with the trained LightGBM model, percentile-ranks within
the batch, and writes per-ticker {raw_score, rank_pct, hist_vol_30} to stdout.

Called once per `deepmoney_sync` run by `analyzer.ts` — NOT once per ticker.
The TS layer assembles all candidate payloads first (they're already being
fetched today for the Monte Carlo path) and hands the batch over here in one
shot.

Input contract — each candidate matches the payload shape that
predict_weighted_analysis.py already consumes, so the TS layer can pass the
same dict it builds for the Monte Carlo call:
  {
    "snapshot_date": "2026-06-18",
    "candidates": [
      {
        "ticker": "AAPL",
        "historicalData": [{"Date": "2024-01-02", "Open": ..., "High": ...,
                            "Low": ..., "Close": ..., "Volume": ...}, ...],
        "macroData": {
          "vix":          [{"date": "...", "close": ...}, ...],
          "treasury10y":  [...],
          "treasury3m":   [...],
          "spy":          [...],
          "sectorEtf":    {"ticker": "XLK", "data": [...]},
          "hyg":          [...],
          "lqd":          [...],
          "dxy":          [...],
          "wti":          [...],
          "copper":       [...],
          "wheat":        [...],
          "worldBank":    {"indicators": {"gdpGrowth": ..., "inflation": ...,
                                          "consumptionGrowth": ...}}
        }
      },
      ...
    ]
  }

Output:
  {
    "feature_set_version": "green_v1",
    "model_path": "models/ranker_v1_regression.txt",
    "snapshot_date": "2026-06-18",
    "scored_count": 467,
    "skipped": ["TICKR1", "TICKR2"],
    "scores": {
      "AAPL": {"raw_score": 0.523, "rank_pct": 0.78, "hist_vol_30": 0.21},
      ...
    }
  }

The `hist_vol_30` field is returned so the TS-side GPS-Light calculator can
use it as the model-uncertainty proxy without recomputing it.

CONSTRAINT: like predict_weighted_analysis.py, this script must NOT make
network calls. All data arrives via the input payload.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

try:
    import lightgbm as lgb
except ImportError:
    print(
        json.dumps({"error": "lightgbm not installed; pip install lightgbm"}),
        file=sys.stderr,
    )
    sys.exit(1)

from ranker_features import (
    FEATURE_COLUMNS,
    FEATURE_SET_VERSION,
    MIN_HISTORY_ROWS,
    compute_features,
)


PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = PROJECT_ROOT / "models"
DEFAULT_MODEL = MODELS_DIR / "ranker_v1_regression.txt"
DEFAULT_MANIFEST = MODELS_DIR / "feature_manifest.json"


# ─── Payload → pandas conversion ────────────────────────────────────────────
def _ohlcv_to_df(historical_data: List[Dict[str, Any]]) -> pd.DataFrame:
    """Convert [{Date, Open, High, Low, Close, Volume}, ...] to a date-indexed
    DataFrame with lowercase column names matching ranker_features.compute_features."""
    if not historical_data:
        return pd.DataFrame()
    df = pd.DataFrame(historical_data)
    # Normalize column casing — payloads vary between sources
    rename = {}
    for c in df.columns:
        lc = c.lower()
        if lc in ("date", "open", "high", "low", "close", "volume"):
            rename[c] = lc
    df = df.rename(columns=rename)
    if "date" not in df.columns:
        return pd.DataFrame()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date"]).set_index("date").sort_index()
    needed = ["open", "high", "low", "close", "volume"]
    for c in needed:
        if c not in df.columns:
            return pd.DataFrame()
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[needed].dropna(how="all")


def _series_from_macro(series_list: Optional[List[Dict[str, Any]]]) -> Optional[pd.Series]:
    """Convert [{date, close}, ...] to a date-indexed Series."""
    if not series_list:
        return None
    df = pd.DataFrame(series_list)
    if df.empty or "date" not in df.columns or "close" not in df.columns:
        return None
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date"]).set_index("date").sort_index()
    s = pd.to_numeric(df["close"], errors="coerce").dropna()
    return s if not s.empty else None


def _build_macro_dict(macro_payload: Dict[str, Any]) -> Tuple[Dict[str, Optional[pd.Series]], Optional[pd.Series]]:
    """Returns (macro_series_by_key, sector_etf_close)."""
    # Same keys ranker_features.compute_features expects
    key_map = {
        "vix": "vix",
        "tnx": "treasury10y",
        "irx": "treasury3m",
        "hyg": "hyg",
        "lqd": "lqd",
        "dxy": "dxy",
        "spy": "spy",
        "wti": "wti",
        "copper": "copper",
        "wheat": "wheat",
    }
    macro: Dict[str, Optional[pd.Series]] = {}
    for short_key, payload_key in key_map.items():
        macro[short_key] = _series_from_macro(macro_payload.get(payload_key))

    sector_etf = macro_payload.get("sectorEtf") or {}
    sector_etf_close = _series_from_macro(sector_etf.get("data"))

    return macro, sector_etf_close


def _wb_year_dict(macro_payload: Dict[str, Any]) -> Dict[str, float]:
    wb = (macro_payload.get("worldBank") or {}).get("indicators") or {}
    out: Dict[str, float] = {}
    for k in ("gdpGrowth", "inflation", "consumptionGrowth"):
        v = wb.get(k)
        if v is not None:
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                pass
    return out


# ─── Model loading ──────────────────────────────────────────────────────────
def load_model_and_manifest(model_path: Path, manifest_path: Path) -> Tuple[lgb.Booster, List[str]]:
    if not model_path.exists():
        raise FileNotFoundError(
            f"Model not found at {model_path}. "
            f"Run scripts/train_ranker.py first."
        )
    booster = lgb.Booster(model_file=str(model_path))

    # When a manifest is present, return the columns *in manifest order* so the
    # feature matrix fed to booster.predict matches the column positions used
    # at training time. Order-only drift from ranker_features.FEATURE_COLUMNS
    # is recoverable; set-level drift (added/removed columns) is not.
    feature_cols: List[str] = FEATURE_COLUMNS
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        manifest_cols = manifest.get("feature_columns")
        if manifest_cols:
            if set(manifest_cols) != set(FEATURE_COLUMNS):
                added = set(FEATURE_COLUMNS) - set(manifest_cols)
                removed = set(manifest_cols) - set(FEATURE_COLUMNS)
                raise RuntimeError(
                    f"Feature column drift: model trained with {len(manifest_cols)} cols, "
                    f"ranker_features.py exposes {len(FEATURE_COLUMNS)}. "
                    f"Added={sorted(added)} Removed={sorted(removed)}. Retrain or align."
                )
            feature_cols = list(manifest_cols)
        if manifest.get("feature_set_version") and manifest["feature_set_version"] != FEATURE_SET_VERSION:
            raise RuntimeError(
                f"Feature-set version mismatch: model='{manifest['feature_set_version']}' "
                f"vs ranker_features.py='{FEATURE_SET_VERSION}'."
            )

    return booster, feature_cols


# ─── Scoring ────────────────────────────────────────────────────────────────
def score_candidates(
    booster: lgb.Booster,
    feature_cols: List[str],
    candidates: List[Dict[str, Any]],
    snap: pd.Timestamp,
) -> Tuple[Dict[str, Dict[str, float]], List[str]]:
    feature_rows: List[Dict[str, Optional[float]]] = []
    tickers_in_order: List[str] = []
    hist_vols: List[Optional[float]] = []
    skipped: List[str] = []

    for cand in candidates:
        ticker = cand.get("ticker")
        if not ticker:
            continue

        ohlcv = _ohlcv_to_df(cand.get("historicalData", []))
        if ohlcv.empty:
            skipped.append(ticker)
            continue

        macro, sector_etf_close = _build_macro_dict(cand.get("macroData", {}) or {})
        wb_year = _wb_year_dict(cand.get("macroData", {}) or {})

        feats = compute_features(snap, ohlcv, sector_etf_close, macro, wb_year)
        if feats is None:
            # insufficient history — typically < 260 bars
            skipped.append(ticker)
            continue

        feature_rows.append(feats)
        tickers_in_order.append(ticker)
        hist_vols.append(feats.get("HistVol_30"))

    if not feature_rows:
        return {}, skipped

    # Build feature matrix in column order. LightGBM requires int/float/bool
    # dtypes; ranker_features.py can emit Python None for missing features
    # (macro data, valuation ratios), which pandas types as `object`. Coerce
    # everything to float64 (None → NaN) so LightGBM's native NaN handling
    # kicks in. Then strip infinities the same way.
    x = pd.DataFrame(feature_rows)[feature_cols]
    x = x.apply(pd.to_numeric, errors='coerce').replace([np.inf, -np.inf], np.nan)
    raw_scores = booster.predict(x)

    # Cross-sectional percentile rank within the batch
    rank_pct = pd.Series(raw_scores).rank(pct=True).values

    scores: Dict[str, Dict[str, float]] = {}
    for i, ticker in enumerate(tickers_in_order):
        hv = hist_vols[i]
        scores[ticker] = {
            "raw_score": float(raw_scores[i]),
            "rank_pct": float(rank_pct[i]),
            "hist_vol_30": float(hv) if hv is not None and not np.isnan(hv) else None,
        }
    return scores, skipped


# ─── Main ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-file", help="Path to JSON input. If omitted, reads stdin.")
    ap.add_argument("--model", default=str(DEFAULT_MODEL), help=f"LightGBM .txt model file (default: {DEFAULT_MODEL.name})")
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="Feature manifest JSON")
    args = ap.parse_args()

    if args.input_file:
        payload = json.loads(Path(args.input_file).read_text())
    else:
        payload = json.loads(sys.stdin.read())

    snapshot_date = payload.get("snapshot_date")
    if not snapshot_date:
        print(json.dumps({"error": "missing snapshot_date in payload"}), file=sys.stderr)
        return 1
    snap = pd.Timestamp(snapshot_date)

    candidates = payload.get("candidates") or []
    if not candidates:
        print(json.dumps({"error": "no candidates in payload"}), file=sys.stderr)
        return 1

    booster, feature_cols = load_model_and_manifest(Path(args.model), Path(args.manifest))
    scores, skipped = score_candidates(booster, feature_cols, candidates, snap)

    out = {
        "feature_set_version": FEATURE_SET_VERSION,
        "model_path": str(Path(args.model).name),
        "snapshot_date": snapshot_date,
        "scored_count": len(scores),
        "skipped": skipped,
        "scores": scores,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
