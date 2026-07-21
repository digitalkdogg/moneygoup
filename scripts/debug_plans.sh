#!/usr/bin/env bash
# debug_plans.sh — Diagnose Plan 1 (cache TTL) and Plan 3 (warm service) on Bluehost.
# Run from the project root: bash scripts/debug_plans.sh
# Paste the full output into chat.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HR="────────────────────────────────────────────────────────"

echo "$HR"
echo "  MONEYGOUP PLAN 1 + 3 DIAGNOSTIC  $(date)"
echo "$HR"

# ── 1. Environment ────────────────────────────────────────────────────────────
echo ""
echo "=== 1. ENVIRONMENT (.env.production) ==="
ENV_FILE="$ROOT/.env.production"
if [[ -f "$ENV_FILE" ]]; then
    grep -E "^(PREDICTION_SERVICE_URL|PREDICTION_SERVICE_PORT|MODEL_VARIANT|CS_MODEL_VERSION|ST_CS_MODEL_VERSION|USE_LEGACY|NODE_ENV)" "$ENV_FILE" || echo "  (none of the target vars found)"
else
    echo "  .env.production NOT FOUND at $ENV_FILE"
fi

echo ""
echo "=== 2. ENVIRONMENT (.env.local) ==="
ENV_LOCAL="$ROOT/.env.local"
if [[ -f "$ENV_LOCAL" ]]; then
    grep -E "^(PREDICTION_SERVICE_URL|PREDICTION_SERVICE_PORT|MODEL_VARIANT|CS_MODEL_VERSION|ST_CS_MODEL_VERSION|USE_LEGACY|NODE_ENV)" "$ENV_LOCAL" || echo "  (none of the target vars found)"
else
    echo "  .env.local not present (OK on prod)"
fi

# ── 2. Cache TTL source check ─────────────────────────────────────────────────
echo ""
echo "=== 3. PLAN 1 — CACHE TTL (src/utils/cache.ts) ==="
CACHE_TS="$ROOT/src/utils/cache.ts"
if [[ -f "$CACHE_TS" ]]; then
    echo "  Source line:"
    grep -n "predictionCache" "$CACHE_TS" || echo "  (predictionCache not found)"
    # Extract the TTL value and eval it so we can show the resolved milliseconds
    TTL_EXPR=$(grep "predictionCache" "$CACHE_TS" | grep -oP '\([\d\s\*]+\)' | head -1 | tr -d '()')
    if [[ -n "$TTL_EXPR" ]]; then
        TTL_MS=$(node -e "console.log($TTL_EXPR)" 2>/dev/null || echo "?")
        TTL_S=$((TTL_MS / 1000))
        echo "  TTL expression: ($TTL_EXPR) = ${TTL_MS}ms = ${TTL_S}s"
        if [[ "$TTL_MS" -ge 60000 ]]; then
            echo "  STATUS: OK — TTL is >= 60 seconds"
        else
            echo "  STATUS: BUG — TTL is only ${TTL_MS}ms (expected 900000ms / 15 min)"
        fi
    fi
else
    echo "  cache.ts NOT FOUND"
fi

# Also check the compiled .js output if Next.js has been built
echo ""
echo "  Checking compiled output for predictionCache..."
find "$ROOT/.next" -name "*.js" -newer "$CACHE_TS" 2>/dev/null | head -5 | while read f; do
    MATCH=$(grep -o "predictionCache.*new Cache[^)]*)" "$f" 2>/dev/null | head -1 || true)
    [[ -n "$MATCH" ]] && echo "  $f: $MATCH"
done || echo "  (no compiled files found newer than cache.ts — .next may not exist)"

# ── 3. PM2 status ─────────────────────────────────────────────────────────────
echo ""
echo "=== 4. PLAN 3 — PM2 STATUS ==="
pm2 jlist 2>/dev/null | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const svc = data.find(p => p.name === 'prediction-service');
const app = data.find(p => p.name === 'moneygoup');
function fmt(p) {
    if (!p) return '  NOT FOUND in PM2';
    const m = p.pm2_env || {};
    return [
        '  name:    ' + p.name,
        '  status:  ' + p.pm2_env.status,
        '  pid:     ' + (p.pid || 'none'),
        '  uptime:  ' + m.pm_uptime ? new Date(m.pm_uptime).toISOString() : '?',
        '  restarts:' + m.restart_time,
        '  memory:  ' + Math.round((p.monit||{}).memory/1024/1024) + ' MB',
    ].join('\n');
}
console.log('  prediction-service:');
console.log(fmt(svc));
console.log('  moneygoup:');
console.log(fmt(app));
" 2>/dev/null || pm2 status 2>/dev/null || echo "  pm2 not available"

# ── 4. Health endpoint ────────────────────────────────────────────────────────
echo ""
echo "=== 5. PLAN 3 — WARM SERVICE /health ==="
PORT="${PREDICTION_SERVICE_PORT:-7861}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
echo "  Hitting $HEALTH_URL ..."
HTTP_CODE=$(curl -s -o /tmp/debug_health.json -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "FAILED")
if [[ "$HTTP_CODE" == "200" ]]; then
    echo "  HTTP $HTTP_CODE — $(cat /tmp/debug_health.json)"
    echo "  STATUS: OK — warm service is up"
else
    echo "  HTTP $HTTP_CODE — warm service is NOT responding"
    echo "  STATUS: FAIL"
fi

# ── 5. Time two consecutive prediction requests ───────────────────────────────
# Uses a well-known ticker (AAPL) via the API. First call = cold (no cache),
# second call should hit cache (Plan 1) or warm service (Plan 3).
echo ""
echo "=== 6. PLAN 1+3 — TIMING TEST (two AAPL requests) ==="
API_BASE="http://127.0.0.1:3001/api/prediction"
TICKER="AAPL"

echo "  Request 1 (should be uncached)..."
T1_START=$(date +%s%N)
R1=$(curl -s -o /tmp/debug_r1.json -w "%{http_code}" --max-time 120 \
    -H "x-api-key: ${INTERNAL_API_KEY:-}" \
    "${API_BASE}/${TICKER}?force_refresh=true&outlook=1_week" 2>/dev/null || echo "FAILED")
T1_END=$(date +%s%N)
T1_MS=$(( (T1_END - T1_START) / 1000000 ))

if [[ "$R1" == "200" ]]; then
    SOURCE1=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/tmp/debug_r1.json'));console.log(d.source||'unknown');}catch(e){console.log('parse error');}" 2>/dev/null)
    echo "  HTTP $R1 | time: ${T1_MS}ms | source: ${SOURCE1}"
else
    echo "  HTTP $R1 | time: ${T1_MS}ms | FAILED"
    echo "  Response body: $(cat /tmp/debug_r1.json 2>/dev/null | head -c 300)"
fi

echo "  Request 2 (should hit cache)..."
T2_START=$(date +%s%N)
R2=$(curl -s -o /tmp/debug_r2.json -w "%{http_code}" --max-time 120 \
    -H "x-api-key: ${INTERNAL_API_KEY:-}" \
    "${API_BASE}/${TICKER}?outlook=1_week" 2>/dev/null || echo "FAILED")
T2_END=$(date +%s%N)
T2_MS=$(( (T2_END - T2_START) / 1000000 ))

if [[ "$R2" == "200" ]]; then
    SOURCE2=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/tmp/debug_r2.json'));console.log(d.source||'unknown');}catch(e){console.log('parse error');}" 2>/dev/null)
    echo "  HTTP $R2 | time: ${T2_MS}ms | source: ${SOURCE2}"
else
    echo "  HTTP $R2 | time: ${T2_MS}ms | FAILED"
    echo "  Response body: $(cat /tmp/debug_r2.json 2>/dev/null | head -c 300)"
fi

echo ""
echo "  Interpretation:"
if [[ "$T2_MS" -lt 500 ]]; then
    echo "  Plan 1 (cache): WORKING — second request was ${T2_MS}ms (cache hit)"
else
    echo "  Plan 1 (cache): NOT WORKING — second request was ${T2_MS}ms (expected <500ms)"
fi
if [[ "$T1_MS" -lt 15000 ]]; then
    echo "  Plan 3 (warm service): LIKELY WORKING — first request was ${T1_MS}ms (expected ~8-10s for warm, ~30s+ for spawn)"
elif [[ "$T1_MS" -lt 35000 ]]; then
    echo "  Plan 3 (warm service): UNCLEAR — first request was ${T1_MS}ms (warm=~8-10s, spawn=~30s+)"
else
    echo "  Plan 3 (warm service): NOT WORKING — first request was ${T1_MS}ms (falling back to spawn)"
fi

# ── 6. Recent PM2 logs ────────────────────────────────────────────────────────
echo ""
echo "=== 7. PM2 LOGS — prediction-service (last 30 lines) ==="
pm2 logs prediction-service --lines 30 --nostream 2>/dev/null || echo "  (no logs available)"

echo ""
echo "=== 8. PM2 LOGS — moneygoup (last 20 lines) ==="
pm2 logs moneygoup --lines 20 --nostream 2>/dev/null || echo "  (no logs available)"

# ── 7. ecosystem.config.js check ─────────────────────────────────────────────
echo ""
echo "=== 9. ECOSYSTEM.CONFIG.JS — prediction-service entry ==="
ECO="$ROOT/ecosystem.config.js"
if [[ -f "$ECO" ]]; then
    # Print prediction-service block
    node -e "
const cfg = require('$ECO');
const app = cfg.apps.find(a => a.name === 'prediction-service');
if (app) { console.log(JSON.stringify(app, null, 2)); }
else { console.log('  prediction-service entry NOT FOUND in ecosystem.config.js'); }
" 2>/dev/null || grep -A 20 "prediction-service" "$ECO" || echo "  (could not parse)"
else
    echo "  ecosystem.config.js NOT FOUND"
fi

echo ""
echo "$HR"
echo "  DIAGNOSTIC COMPLETE"
echo "$HR"
