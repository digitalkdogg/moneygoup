#!/usr/bin/env python3
"""
prediction_service.py — Long-running FastAPI inference service.

Loads TF/sklearn/pandas and model artifacts ONCE on startup, then serves
predictions via HTTP.  Replaces the spawn-a-new-Python-process-per-request
pattern in route.ts so every cache miss no longer pays TF import + model
deserialization from disk.

USAGE:
    # Start (PM2 handles this automatically):
    python3 scripts/prediction_service.py

    # Test readiness:
    curl http://127.0.0.1:7861/health

    # Run a prediction (same payload as the temp JSON file):
    curl -X POST http://127.0.0.1:7861/predict \
         -H 'Content-Type: application/json' \
         -d '{"ticker":"AAPL","input_data":{...},"outlook":"all"}'

Set PREDICTION_SERVICE_PORT to change the port (default 7861).
Set PREDICTION_SERVICE_URL=http://127.0.0.1:7861 in .env.local to activate
the warm path in route.ts (falls back to spawn if unset or unreachable).
"""
from __future__ import annotations

import json
import os
import sys
import traceback

# ── CPU-throttling env vars before any TF/numpy import ────────────────────
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
os.environ.setdefault('TF_NUM_INTRAOP_THREADS', '2')
os.environ.setdefault('TF_NUM_INTEROP_THREADS', '2')
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from dotenv import load_dotenv
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

# ── Heavy imports — happen once at service startup ─────────────────────────
print('[prediction_service] Loading model stack...', file=sys.stderr, flush=True)
_load_error: str | None = None
try:
    import predict_weighted_analysis as _pwa
    from predict_core import (
        get_cache_key, load_from_cache, save_to_cache,
        _sanitize_predictions, NumpyEncoder,
    )
    print('[prediction_service] Model stack ready.', file=sys.stderr, flush=True)
except Exception as _exc:
    _load_error = traceback.format_exc()
    print(f'[prediction_service] FATAL: {_load_error}', file=sys.stderr, flush=True)

# ── FastAPI app ────────────────────────────────────────────────────────────
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title='prediction_service')


@app.get('/health')
def health():
    if _load_error:
        raise HTTPException(status_code=503, detail={'ready': False, 'error': _load_error})
    return {'ready': True}


class PredictRequest(BaseModel):
    ticker: str
    input_data: dict
    outlook: str = 'all'


_OUTLOOK_CHOICES = {'1_week', '1_month', '6_month', '1_year', 'all'}


@app.post('/predict')
def predict(req: PredictRequest):
    if _load_error:
        raise HTTPException(status_code=503, detail='Models not loaded')

    outlook = req.outlook if req.outlook in _OUTLOOK_CHOICES else 'all'

    try:
        hist = req.input_data.get('historicalData', [])
        ckey = get_cache_key(req.ticker, hist)
        result = load_from_cache(ckey)
        if result is None:
            result = _pwa.predict(req.ticker, req.input_data)
            save_to_cache(ckey, result)

        # Narrator runs on every call (same as CLI), regardless of cache hit.
        try:
            from prediction_narrator import build_prediction_rationale
            stock_metrics = req.input_data.get('stockMetrics', {}) or {}
            result['llm_rationale'] = build_prediction_rationale(
                req.ticker,
                result,
                feature_ctx={'analyst_rating': stock_metrics.get('recommendationKey')},
            )
        except Exception:
            result['llm_rationale'] = None

        result = _sanitize_predictions(result)

        # Filter to requested outlook (mirrors CLI __main__ block).
        if outlook != 'all':
            filtered: dict = {
                'ticker': result['ticker'],
                'regularMarketPrice': result['regularMarketPrice'],
                'outlook': outlook,
                'data_quality': result.get('data_quality'),
                'accuracy_metrics': result.get('accuracy_metrics'),
                'regime_info': result.get('regime_info'),
            }
            if outlook == '1_week':
                filtered.update({
                    'predicted_price_1w': result.get('predicted_price_1w'),
                    'predicted_change_pct_1w': result.get('predicted_change_pct_1w'),
                    'confidence_score_1w': result.get('confidence_score_1w'),
                    'predicted_range_1w': result.get('predicted_range_1w'),
                    'predicted_direction_1w': result.get('predicted_direction_1w'),
                })
            elif outlook == '1_month':
                filtered.update({
                    'predicted_price_1m': result.get('predicted_price_1m'),
                    'predicted_change_pct_1m': result.get('predicted_change_pct_1m'),
                    'confidence_score_1m': result.get('confidence_score_1m'),
                    'predicted_direction_1m': result.get('predicted_direction_1m'),
                })
            elif outlook == '6_month':
                filtered.update({
                    'predicted_price_6m': result.get('predicted_price_6m'),
                    'predicted_change_pct_6m': result.get('predicted_change_pct_6m'),
                    'confidence_score_6m': result.get('confidence_score_6m'),
                    'predicted_direction_6m': result.get('predicted_direction_6m'),
                    'monthly_trajectory': result.get('monthly_trajectory'),
                })
            elif outlook == '1_year':
                filtered.update({
                    'predicted_price_1y': result.get('predicted_price_1y'),
                    'predicted_change_pct_1y': result.get('predicted_change_pct_1y'),
                    'confidence_score_1y': result.get('confidence_score_1y'),
                    'predicted_direction_1y': result.get('predicted_direction_1y'),
                    'monthly_trajectory': result.get('monthly_trajectory'),
                })
            result = filtered

        # FastAPI's JSON encoder can't handle numpy types; round-trip through
        # NumpyEncoder first.
        safe_result = json.loads(json.dumps(result, cls=NumpyEncoder))
        return JSONResponse(content=safe_result)

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={'error': str(exc), 'traceback': traceback.format_exc()},
        )


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('PREDICTION_SERVICE_PORT', '7861'))
    print(f'[prediction_service] Starting on 127.0.0.1:{port}', file=sys.stderr, flush=True)
    uvicorn.run(
        'prediction_service:app',
        host='127.0.0.1',
        port=port,
        workers=1,
        log_level='info',
        access_log=False,
    )
