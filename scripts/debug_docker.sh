#!/usr/bin/env bash
# debug_docker.sh — Check whether the growmystocks Docker container can reach
# the warm prediction service and what env vars Next.js actually sees.
# Run from the project root: bash scripts/debug_docker.sh

set -euo pipefail
HR="────────────────────────────────────────────────────────"
CONTAINER="growmystocks"

echo "$HR"
echo "  DOCKER / WARM-SERVICE DIAGNOSTIC  $(date)"
echo "$HR"

# ── 1. Confirm container is running ──────────────────────────────────────────
echo ""
echo "=== 1. CONTAINER STATUS ==="
docker inspect "$CONTAINER" --format \
    'name={{.Name}}  status={{.State.Status}}  pid={{.State.Pid}}' 2>/dev/null \
    || { echo "  ERROR: container '$CONTAINER' not found"; exit 1; }

# ── 2. Env vars Next.js actually sees ────────────────────────────────────────
echo ""
echo "=== 2. ENV VARS INSIDE CONTAINER ==="
echo "  (PREDICTION_SERVICE_URL, MODEL_VARIANT, CS_MODEL_VERSION, USE_LEGACY)"
docker exec "$CONTAINER" env 2>/dev/null \
    | grep -E "PREDICTION_SERVICE|MODEL_VARIANT|CS_MODEL|USE_LEGACY|NODE_ENV" \
    || echo "  NONE of those vars found inside the container"

# ── 3. Network reachability from inside the container ─────────────────────────
echo ""
echo "=== 3. WARM SERVICE REACHABILITY FROM INSIDE CONTAINER ==="

echo "  a) via 127.0.0.1:7861 ..."
RESULT_A=$(docker exec "$CONTAINER" sh -c \
    'curl -s --max-time 4 http://127.0.0.1:7861/health 2>&1 || echo "FAILED"')
echo "     $RESULT_A"

echo "  b) via host.docker.internal:7861 ..."
RESULT_B=$(docker exec "$CONTAINER" sh -c \
    'curl -s --max-time 4 http://host.docker.internal:7861/health 2>&1 || echo "FAILED"')
echo "     $RESULT_B"

# Try to find the host IP from the container's default gateway
echo "  c) via host gateway IP:7861 ..."
HOST_IP=$(docker exec "$CONTAINER" sh -c \
    "ip route show default 2>/dev/null | awk '/default/ {print \$3}' | head -1" 2>/dev/null || echo "")
if [[ -n "$HOST_IP" ]]; then
    RESULT_C=$(docker exec "$CONTAINER" sh -c \
        "curl -s --max-time 4 http://${HOST_IP}:7861/health 2>&1 || echo 'FAILED'")
    echo "     host gateway = $HOST_IP  →  $RESULT_C"
else
    echo "     could not determine host gateway IP"
fi

echo ""
echo "  Interpretation:"
if echo "$RESULT_A" | grep -q '"ready"'; then
    echo "  127.0.0.1:7861 REACHABLE from container — Plan 3 should work as-is"
elif echo "$RESULT_B" | grep -q '"ready"'; then
    echo "  host.docker.internal:7861 REACHABLE — fix: change PREDICTION_SERVICE_URL to http://host.docker.internal:7861"
elif echo "$RESULT_C" | grep -q '"ready"' 2>/dev/null; then
    echo "  Host gateway ($HOST_IP):7861 REACHABLE — fix: change PREDICTION_SERVICE_URL to http://${HOST_IP}:7861"
else
    echo "  NONE of the addresses reached the warm service from inside the container"
    echo "  Fix options: (1) add --network host to docker run, or (2) expose port 7861 in docker-compose/run args"
fi

# ── 4. How the container was started (network mode, port bindings) ───────────
echo ""
echo "=== 4. CONTAINER NETWORK CONFIG ==="
docker inspect "$CONTAINER" --format \
    'network_mode={{.HostConfig.NetworkMode}}  ports={{.HostConfig.PortBindings}}' 2>/dev/null

# ── 5. Does curl exist in the container? (sanity check) ──────────────────────
echo ""
echo "=== 5. TOOLS AVAILABLE INSIDE CONTAINER ==="
docker exec "$CONTAINER" sh -c 'which curl && curl --version | head -1' 2>/dev/null \
    || echo "  curl not found in container (that explains FAILED above)"

echo ""
echo "$HR"
echo "  DIAGNOSTIC COMPLETE"
echo "$HR"
