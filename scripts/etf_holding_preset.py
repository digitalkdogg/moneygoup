"""Python mirror of src/utils/etfHoldingPreset.ts.

Loads models/etf_holding_presets.json and resolves a level (1.0..10.0,
fractional allowed) to a preset dict via the same linear-interpolation
rule as the TS side. Used by scripts/update_predictions.py so the per-user
ETF holding sync uses identical thresholds to the Next.js routes.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

_LOG = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_PRESETS_PATH = _PROJECT_ROOT / "models" / "etf_holding_presets.json"
_DEFAULT_LEVEL = 5.0

_cached_table: dict | None = None


def _load_table() -> dict:
    global _cached_table
    if _cached_table is None:
        with _PRESETS_PATH.open() as f:
            _cached_table = json.load(f)
    return _cached_table


def clamp_etf_holding_level(raw: str | None) -> float:
    """Parse ETF_HOLDING_ALGORITHM; clamp to [1,10]; default to 5 on bad input."""
    if not raw:
        return _DEFAULT_LEVEL
    try:
        n = float(raw)
    except ValueError:
        _LOG.warning("Invalid ETF_HOLDING_ALGORITHM=%r, defaulting to %s", raw, _DEFAULT_LEVEL)
        return _DEFAULT_LEVEL
    if n < 1 or n > 10:
        _LOG.warning("ETF_HOLDING_ALGORITHM=%r out of range [1,10], defaulting to %s", raw, _DEFAULT_LEVEL)
        return _DEFAULT_LEVEL
    return n


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def load_etf_holding_preset(level: float) -> dict:
    """Return the preset for the given level; interpolate for fractional levels."""
    table = _load_table()
    lo, hi = int(level // 1), int(-(-level // 1))  # floor / ceil
    if lo < 1: lo = 1
    if hi > 10: hi = 10
    lower = table[str(lo)]
    if lo == hi:
        return dict(lower)
    upper = table[str(hi)]
    t = level - lo
    return {
        "etfGpsThreshold":  _lerp(lower["etfGpsThreshold"],  upper["etfGpsThreshold"],  t),
        "topNEtfs":         round(_lerp(lower["topNEtfs"],   upper["topNEtfs"],   t)),
        "maxTickers":       round(_lerp(lower["maxTickers"], upper["maxTickers"], t)),
        "gpsSurfaceValue":  _lerp(lower["gpsSurfaceValue"],  upper["gpsSurfaceValue"],  t),
        "minPredChangePct": _lerp(lower["minPredChangePct"], upper["minPredChangePct"], t),
    }


def resolve_etf_holding_algorithm(raw: str | None = None) -> dict:
    """One-shot: read env (default ETF_HOLDING_ALGORITHM), clamp, interpolate."""
    if raw is None:
        raw = os.getenv("ETF_HOLDING_ALGORITHM")
    level = clamp_etf_holding_level(raw)
    preset = load_etf_holding_preset(level)
    preset["level"] = level
    return preset
