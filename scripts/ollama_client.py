"""
scripts/ollama_client.py — Python mirror of src/utils/ollamaClient.ts.

Same contract, same semantics:
    is_ollama_enabled()           -> bool
    check_ollama_reachable()      -> bool
    generate(prompt, ...)         -> str | None
    generate_json(prompt, ...)    -> dict | list | None

Every failure path (network error, non-2xx, timeout, malformed JSON) returns
None. Never raises. Callers must accept None as a valid "Ollama unavailable"
result and degrade gracefully — this module is used from batch scripts that
must not fail when the local LLM daemon is down.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Optional

import requests


DEFAULT_BASE_URL          = os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434')
DEFAULT_MODEL             = os.getenv('OLLAMA_MODEL', 'llama3.2')
DEFAULT_TIMEOUT_MS        = int(os.getenv('OLLAMA_TIMEOUT_MS', '8000'))
REACHABLE_PROBE_TIMEOUT_S = 2.0

# Circuit-breaker: after _CB_THRESHOLD consecutive probe failures, skip
# check_ollama_reachable() for _CB_COOLDOWN_S seconds.  Prevents every
# async narration job from paying the 2s probe cost when Ollama is down.
_CB_THRESHOLD  = 3
_CB_COOLDOWN_S = 60.0
_cb_lock       = threading.Lock()
_cb_failures   = 0
_cb_open_until = 0.0


def is_ollama_enabled() -> bool:
    """Feature flag — mirrors OLLAMA_ENABLED in the Node side."""
    return os.getenv('OLLAMA_ENABLED', 'false').lower() == 'true'


def check_ollama_reachable(base_url: str = DEFAULT_BASE_URL) -> bool:
    """Lightweight probe with circuit breaker.  Returns False immediately
    during a cooldown window so callers skip all Ollama work without paying
    the probe timeout on every request."""
    global _cb_failures, _cb_open_until
    now = time.monotonic()
    with _cb_lock:
        if now < _cb_open_until:
            return False
    try:
        r = requests.get(f"{base_url}/api/tags", timeout=REACHABLE_PROBE_TIMEOUT_S)
        ok = r.ok
    except Exception:
        ok = False
    with _cb_lock:
        if ok:
            _cb_failures = 0
        else:
            _cb_failures += 1
            if _cb_failures >= _CB_THRESHOLD:
                _cb_open_until = time.monotonic() + _CB_COOLDOWN_S
    return ok


def generate(
    prompt: str,
    *,
    model: Optional[str] = None,
    timeout_ms: Optional[int] = None,
    json_mode: bool = False,
    temperature: float = 0.0,
    num_predict: int = 300,
    base_url: str = DEFAULT_BASE_URL,
) -> Optional[str]:
    """Send a prompt to Ollama's /api/generate. Returns the raw response
    string, or None on ANY failure (network, non-2xx, timeout, malformed
    response). Never raises."""
    if not prompt or not prompt.strip():
        return None

    _model      = model or DEFAULT_MODEL
    _timeout_s  = (timeout_ms or DEFAULT_TIMEOUT_MS) / 1000.0

    body: dict = {
        'model':   _model,
        'prompt':  prompt,
        'stream':  False,
        'options': {'temperature': temperature, 'num_predict': num_predict},
    }
    if json_mode:
        body['format'] = 'json'

    try:
        r = requests.post(f"{base_url}/api/generate", json=body, timeout=_timeout_s)
        if not r.ok:
            return None
        data = r.json()
        raw = data.get('response')
        return raw if isinstance(raw, str) else None
    except Exception:
        return None


def generate_json(
    prompt: str,
    **kwargs,
) -> Optional[Any]:
    """Convenience wrapper that sets json_mode=True and runs json.loads on
    the response. Returns the parsed object, or None on any failure (including
    JSON parse errors)."""
    kwargs['json_mode'] = True
    raw = generate(prompt, **kwargs)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Prompt template helpers
# ---------------------------------------------------------------------------

_PROMPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ollama_prompts')


def load_prompt(name: str, **placeholders) -> str:
    """Load a prompt template from scripts/ollama_prompts/<name>.txt and
    substitute {placeholders}. Raises FileNotFoundError if the template
    doesn't exist — templates are code, not data, so a missing one is a
    programmer error, not a runtime one."""
    path = os.path.join(_PROMPTS_DIR, f'{name}.txt')
    with open(path, 'r', encoding='utf-8') as fh:
        template = fh.read()
    return template.format(**placeholders)
