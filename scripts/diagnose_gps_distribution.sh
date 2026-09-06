#!/usr/bin/env bash
# Diagnostic for the "gps_distribution.ts exited N" failure in deepmoney_sync.py.
# Run this from the project root, same context deepmoney_sync.py runs in:
#   Bluehost container:  docker exec growmystocks bash scripts/diagnose_gps_distribution.sh
#   Local (no docker):   bash scripts/diagnose_gps_distribution.sh
set -uo pipefail
cd "$(dirname "$0")/.."

hr() { printf '%.0s-' {1..70}; echo; }

hr
echo "1) Runtime versions"
hr
node --version
npm --version 2>/dev/null
echo "cwd: $(pwd)"

hr
echo "2) .env files present at project root (contents NOT shown)"
hr
ls -la .env* 2>/dev/null || echo "  (none found)"

hr
echo "3) DB-related env vars set? (values masked)"
hr
for v in DATABASE_URL DB_HOST DB_USER DB_PASSWORD DB_DATABASE DB_PORT DB_SSL_REJECT_UNAUTHORIZED; do
  val="${!v-}"
  if [ -n "$val" ]; then
    echo "  $v = SET (${#val} chars)"
  else
    echo "  $v = (unset)"
  fi
done

hr
echo "4) jiti package: version + does it expose ./register?"
hr
if [ -f node_modules/jiti/package.json ]; then
  node -e "const p=require('./node_modules/jiti/package.json'); console.log('  version:', p.version); console.log('  exports[\"./register\"]:', JSON.stringify(p.exports && p.exports['./register']))"
else
  echo "  node_modules/jiti NOT FOUND -- run npm install"
fi

hr
echo "5) mysql2 package present?"
hr
if [ -f node_modules/mysql2/package.json ]; then
  node -e "console.log('  version:', require('./node_modules/mysql2/package.json').version)"
else
  echo "  node_modules/mysql2 NOT FOUND -- run npm install"
fi

hr
echo "6) Does src/utils/db.ts exist and resolve?"
hr
ls -la src/utils/db.ts 2>/dev/null || echo "  MISSING: src/utils/db.ts"

hr
echo "7) Run the ACTUAL command with full stderr (this is the real test)"
hr
ENV_FILE=""
for f in .env.production .env.local .env; do
  if [ -f "$f" ]; then ENV_FILE="$f"; break; fi
done
if [ -n "$ENV_FILE" ]; then
  echo "  Using --env-file=$ENV_FILE"
  node "--env-file=$ENV_FILE" --import jiti/register scripts/gps_distribution.ts
else
  echo "  No .env file found -- relying on inherited process environment"
  node --import jiti/register scripts/gps_distribution.ts
fi
STATUS=$?
echo
echo "  Exit code: $STATUS"

hr
echo "8) If step 7 failed with a jiti/module error, try tsx as a fallback"
hr
if [ -f node_modules/.bin/tsx ]; then
  echo "  tsx is available at node_modules/.bin/tsx -- you can try:"
  echo "    node_modules/.bin/tsx scripts/gps_distribution.ts"
else
  echo "  tsx not installed (not necessarily a problem; just noting availability)"
fi

hr
echo "Done. Paste the FULL output above (especially step 7) back for diagnosis."
hr
