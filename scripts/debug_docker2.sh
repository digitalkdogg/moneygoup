#!/usr/bin/env bash
# debug_docker2.sh — Verify compiled cache TTL inside the container and check
# whether Next.js requests are actually hitting the warm service vs spawning.
# Run from the project root: bash scripts/debug_docker2.sh

set -euo pipefail
HR="────────────────────────────────────────────────────────"
CONTAINER="growmystocks"

echo "$HR"
echo "  DOCKER DEEP DIAGNOSTIC  $(date)"
echo "$HR"

# ── 1. Find the Next.js app root inside the container ────────────────────────
echo ""
echo "=== 1. LOCATING NEXT.JS APP INSIDE CONTAINER ==="
APP_ROOT=$(docker exec "$CONTAINER" sh -c '
    for d in /app /var/www/html/moneygoup /home/app /srv/app; do
        if [ -d "$d/.next" ]; then echo "$d"; exit 0; fi
    done
    # Fallback: search
    find / -name ".next" -maxdepth 6 -type d 2>/dev/null | head -1 | xargs dirname
' 2>/dev/null)
echo "  App root: ${APP_ROOT:-(not found)}"

# ── 2. Check compiled cache TTL in .next build output ────────────────────────
echo ""
echo "=== 2. COMPILED CACHE TTL (Plan 1) ==="
if [[ -n "$APP_ROOT" ]]; then
    docker exec "$CONTAINER" sh -c "
        # Find the compiled chunk that contains predictionCache
        MATCH=\$(grep -rl 'predictionCache' '${APP_ROOT}/.next/server/' 2>/dev/null | head -3)
        if [ -z \"\$MATCH\" ]; then
            echo '  predictionCache not found in .next/server — build may not include it or path differs'
            # Try chunks directory
            MATCH=\$(grep -rl 'predictionCache' '${APP_ROOT}/.next/' 2>/dev/null | head -3)
        fi
        for f in \$MATCH; do
            echo \"  File: \$f\"
            grep -o 'predictionCache[^;)]*' \"\$f\" 2>/dev/null | head -3
        done
        if [ -z \"\$MATCH\" ]; then
            echo '  Could not find predictionCache in any compiled output'
        fi
    " 2>/dev/null || echo "  (exec failed)"

    # Also check when .next was last built vs when cache.ts was modified
    echo ""
    echo "  Build timestamp (.next/BUILD_ID):"
    docker exec "$CONTAINER" sh -c "
        stat '${APP_ROOT}/.next/BUILD_ID' 2>/dev/null | grep -E 'Modify|Change' | head -1 || echo '  BUILD_ID not found'
        cat '${APP_ROOT}/.next/BUILD_ID' 2>/dev/null && echo ''
    " 2>/dev/null || echo "  (could not read BUILD_ID)"
else
    echo "  Skipping — app root not found"
fi

# ── 3. Check source file timestamp on host ────────────────────────────────────
echo ""
echo "=== 3. SOURCE VS BUILD TIMESTAMPS (on host) ==="
HOST_CACHE_TS=$(stat /var/www/html/moneygoup/src/utils/cache.ts 2>/dev/null \
    | grep Modify | awk '{print $2, $3}')
echo "  cache.ts last modified:  ${HOST_CACHE_TS:-(not found)}"

# ── 4. Recent Docker logs (Next.js stdout/stderr) ────────────────────────────
echo ""
echo "=== 4. DOCKER LOGS — LAST 40 LINES ==="
docker logs "$CONTAINER" --tail=40 2>&1 || echo "  (docker logs failed)"

# ── 5. Look for warm-service vs spawn evidence in Docker logs ─────────────────
echo ""
echo "=== 5. WARM SERVICE / SPAWN EVIDENCE IN DOCKER LOGS ==="
echo "  (searching last 200 log lines for routing signals)"
docker logs "$CONTAINER" --tail=200 2>&1 | \
    grep -Ei "warm.service|spawn|prediction.*ms|runWarm|runSpawn|PREDICTION_SERVICE|cold.start" \
    || echo "  No routing signals found in last 200 log lines"

# ── 6. How long has the current container been running ────────────────────────
echo ""
echo "=== 6. CONTAINER UPTIME ==="
docker inspect "$CONTAINER" --format \
    'started={{.State.StartedAt}}  restarts={{.RestartCount}}' 2>/dev/null

# ── 7. prediction-service max_restarts warning ────────────────────────────────
echo ""
echo "=== 7. PM2 RESTART LIMIT CHECK ==="
pm2 jlist 2>/dev/null | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const svc = data.find(p => p.name === 'prediction-service');
if (!svc) { console.log('  prediction-service not in PM2'); process.exit(); }
const restarts = (svc.pm2_env || {}).restart_time || 0;
const maxR = (svc.pm2_env || {}).max_restarts || 'unknown';
console.log('  restarts so far: ' + restarts + '  /  max_restarts: ' + maxR);
if (restarts >= maxR) {
    console.log('  WARNING: restart limit reached — if service crashes again PM2 will NOT restart it');
} else {
    console.log('  OK: ' + (maxR - restarts) + ' restarts remaining');
}
" 2>/dev/null || echo "  (could not parse PM2 list)"

echo ""
echo "$HR"
echo "  DIAGNOSTIC COMPLETE"
echo "$HR"
