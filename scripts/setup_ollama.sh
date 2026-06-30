#!/usr/bin/env bash
# Idempotent setup for the Ollama NER pass dependency.
# Safe to re-run on any host — checks existing state before each step.
#
# Usage:
#   ./scripts/setup_ollama.sh              # install + pull default model
#   OLLAMA_MODEL=mistral ./setup_ollama.sh # override model
#
# Exits 0 if everything is in place at the end, non-zero on any failure.

set -euo pipefail

OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '    \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

step "1. Install Ollama"
if command -v ollama >/dev/null 2>&1; then
    ok "ollama already installed ($(ollama --version 2>&1 | head -1))"
else
    warn "running official install script (requires sudo)"
    curl -fsSL https://ollama.com/install.sh | sh
    command -v ollama >/dev/null 2>&1 || die "install completed but 'ollama' not on PATH"
    ok "installed $(ollama --version 2>&1 | head -1)"
fi

step "2. Start ollama service"
if curl -fsS --max-time 2 "${OLLAMA_BASE_URL}/api/tags" >/dev/null 2>&1; then
    ok "ollama reachable at ${OLLAMA_BASE_URL}"
elif systemctl list-unit-files 2>/dev/null | grep -q '^ollama.service'; then
    warn "service registered but not responding — starting"
    sudo systemctl enable --now ollama
    sleep 2
    curl -fsS --max-time 5 "${OLLAMA_BASE_URL}/api/tags" >/dev/null \
        || die "service started but ${OLLAMA_BASE_URL} still unreachable"
    ok "service started"
else
    die "no systemd unit found and server unreachable — start manually with 'ollama serve &'"
fi

step "3. Pull model: ${OLLAMA_MODEL}"
if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "${OLLAMA_MODEL}\(:latest\)\?"; then
    ok "model ${OLLAMA_MODEL} already present"
else
    warn "downloading ${OLLAMA_MODEL} (this can take several minutes)"
    ollama pull "${OLLAMA_MODEL}"
    ok "pulled ${OLLAMA_MODEL}"
fi

step "4. Smoke test"
RESP=$(curl -fsS --max-time 30 "${OLLAMA_BASE_URL}/api/generate" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"model":"%s","prompt":"Reply with the single word: ok","stream":false,"options":{"num_predict":5}}' "${OLLAMA_MODEL}")") \
    || die "generate call failed"
echo "    raw response: ${RESP}" | head -c 200; echo
ok "model responded"

step "Done"
cat <<EOF
    Next step: ensure these vars are set in the deployment environment
    (.env.production for the API, or the systemd service environment):

      OLLAMA_ENABLED=true
      OLLAMA_BASE_URL=${OLLAMA_BASE_URL}
      OLLAMA_MODEL=${OLLAMA_MODEL}

    Then restart the Next.js service so route.ts picks up the new env.
    Verify with: node --experimental-strip-types scripts/test_ollama_pass.mjs
EOF
