"""
scripts/prediction_narrator.py — LLM-written prediction narrative.

Called from predict_weighted_analysis.predict() after the result dict is
assembled. Reads the prediction outputs + the same feature signals the model
consumed (RSI, 30d/90d momentum, VIX, beta, realized vol) plus the rule-based
confidence reasons, sends them through the prompt template at
scripts/ollama_prompts/prediction_rationale.txt, and returns a short prose
explanation the UI can render as "Why this range".

Contract:
  build_prediction_rationale(ticker, result_dict, feature_ctx) -> str | None

Failure modes (all return None, never raise):
  • OLLAMA_ENABLED is not 'true'
  • Ollama daemon unreachable
  • Generation timeout / non-2xx / malformed response
  • Any exception building the prompt (missing feature — degraded gracefully)

The caller stores None as NULL in prediction_records.llm_rationale, and the UI
falls back to the rule-based confidence_reason_{h} strings when that column
is NULL — so a failed narration path does not degrade the primary product.
"""

from __future__ import annotations

import os
from typing import Optional

from ollama_client import (
    is_ollama_enabled,
    check_ollama_reachable,
    generate,
    load_prompt,
)


# Optional per-feature model override so a slower/larger model can be used
# for narratives without changing the default. Falls back to OLLAMA_MODEL.
RATIONALE_MODEL = os.getenv('OLLAMA_MODEL_RATIONALE', '').strip() or None

# Rationale generation needs a longer timeout than the shared default (which
# is tuned for NER extraction, ~200-token outputs). llama3.2 cold-starts can
# take 8-15s, and a 2-3 sentence narrative can easily push 5s of actual gen
# time even after model load. 30s covers both.
RATIONALE_TIMEOUT_MS = int(os.getenv('OLLAMA_TIMEOUT_MS_RATIONALE', '30000'))
# Slightly longer than default to allow a full 2-3 sentence explanation.
RATIONALE_NUM_PREDICT = 160
# Slightly warmer than 0 so the explanation reads naturally rather than
# reciting the input verbatim.
RATIONALE_TEMPERATURE = 0.2


def _fmt(v, spec: str = '.2f', na: str = 'n/a') -> str:
    """Format helper that keeps NaN/None/inf out of the prompt."""
    if v is None:
        return na
    try:
        f = float(v)
    except (TypeError, ValueError):
        return na
    if f != f or f in (float('inf'), float('-inf')):
        return na
    return format(f, spec)


def build_prediction_rationale(
    ticker: str,
    result: dict,
    feature_ctx: Optional[dict] = None,
) -> Optional[str]:
    """Generate a prose rationale for the given prediction result.

    Args:
      ticker: symbol (e.g. 'AAPL')
      result: the result dict returned by predict() — already includes
              predicted_price_{h}, predicted_change_pct_{h},
              confidence_score_{h}, confidence_reason_{h},
              variant_adjustments telemetry
      feature_ctx: optional dict with signals not in the result dict:
              {'rsi_14d': ..., 'ret30d': ..., 'ret90d': ..., 'vix': ...,
               'beta': ..., 'realized_vol_60d': ..., 'analyst_rating': ...}
              Missing keys are safely rendered as 'n/a'.

    Returns:
      Prose string on success, or None on any failure (feature-flag off,
      daemon down, timeout, template render error). Never raises.
    """
    if not is_ollama_enabled():
        return None
    if not check_ollama_reachable():
        return None

    fc = feature_ctx or {}
    va = result.get('variant_adjustments') or {}

    try:
        prompt = load_prompt(
            'prediction_rationale',
            ticker=ticker,
            current_price=_fmt(result.get('regularMarketPrice')),
            predicted_price_6m=_fmt(result.get('predicted_price_6m')),
            predicted_price_1y=_fmt(result.get('predicted_price_1y')),
            predicted_change_pct_6m=_fmt(result.get('predicted_change_pct_6m'), '.1f'),
            predicted_change_pct_1y=_fmt(result.get('predicted_change_pct_1y'), '.1f'),
            confidence_score_6m=_fmt(result.get('confidence_score_6m'), '.0f'),
            confidence_score_1y=_fmt(result.get('confidence_score_1y'), '.0f'),
            rsi_14d=_fmt(va.get('rsi_14d') or fc.get('rsi_14d'), '.0f'),
            ret30d_pct=_fmt((va.get('ret30d') or fc.get('ret30d') or 0) * 100, '.1f'),
            ret90d_pct=_fmt((va.get('ret90d') or fc.get('ret90d') or 0) * 100, '.1f'),
            vix=_fmt(va.get('vix') or fc.get('vix'), '.1f'),
            beta=_fmt(va.get('beta') or fc.get('beta'), '.2f'),
            realized_vol_pct=_fmt((result.get('realized_vol_60d') or 0) * 100, '.0f'),
            analyst_rating=fc.get('analyst_rating') or 'n/a',
            confidence_reason_6m=result.get('confidence_reason_6m') or 'n/a',
            confidence_reason_1y=result.get('confidence_reason_1y') or 'n/a',
        )
    except Exception:
        # Template rendering failed — safer to skip than to send a malformed
        # prompt. Returns None so the DB column stays NULL.
        return None

    raw = generate(
        prompt,
        model=RATIONALE_MODEL,
        timeout_ms=RATIONALE_TIMEOUT_MS,
        json_mode=False,
        temperature=RATIONALE_TEMPERATURE,
        num_predict=RATIONALE_NUM_PREDICT,
    )
    if raw is None:
        return None

    # Trim and clean up common LLM preambles the prompt asks it not to
    # produce but sometimes does anyway.
    text = raw.strip().strip('"').strip("'")
    for prefix in ('Sure,', 'Sure!', 'Here is', 'Here\'s'):
        if text.startswith(prefix):
            text = text.split(':', 1)[-1].strip()
    # Cap length hard — the prompt asks for max 60 words, but a runaway
    # response would blow past the UI callout budget.
    if len(text) > 600:
        text = text[:600].rsplit('.', 1)[0] + '.'
    return text or None
