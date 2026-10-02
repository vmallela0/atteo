#!/usr/bin/env bash
# Ship main: push, deploy, wait until the new version is actually serving (no fixed sleep), then run the production
# e2e suite and (if CLI-related code changed) the CLI suite in parallel, then clean up test data.
# Needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN and ADMIN_KEY in the environment.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${BASE:-https://agent-board.vedu-mallela.workers.dev}"
# The production key lives in secrets.txt (never committed); .dev.vars holds the local one.
if [ -z "${ADMIN_KEY:-}" ] && [ -f secrets.txt ]; then
  ADMIN_KEY=$(grep -i '^agent board admin key' secrets.txt | sed -E 's/^[^-]*- *//')
fi
: "${ADMIN_KEY:?set ADMIN_KEY}"
# Fail before pushing if the key doesn't open this server's ops API (the test suites need it).
code=$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-key: $ADMIN_KEY" "$BASE/api/ops/overview")
[ "$code" = 200 ] || { echo "ADMIN_KEY is not valid for $BASE (ops API said $code)"; exit 1; }
start=$(date +%s)
# Clear the last run's test data while we deploy; finish before the new suites create theirs (never during them).
scripts/cleanup-e2e.sh --remote >/dev/null 2>&1 & cleanup=$!
git push -q origin HEAD:main
before=$(git rev-parse HEAD@{1} 2>/dev/null || git rev-parse HEAD~1)
out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
ver=$(echo "$out" | sed -nE 's/.*Current Version ID: ([0-9a-f-]+).*/\1/p')
echo "deployed $ver"
for i in $(seq 1 120); do
  [ "$(curl -s "$BASE/health" | sed -nE 's/.*"version":"([^"]*)".*/\1/p')" = "$ver" ] && break
  sleep 0.5
done
echo "live after $(( $(date +%s) - start ))s"
wait $cleanup || true
export ADMIN_KEY BASE
node test/e2e.mjs > /tmp/ship-e2e.log 2>&1 & e2e=$!
cli=""
if git diff --name-only "$before" HEAD | grep -qE '^(cli/|src/(mcp|secrets|device|auth|index|board)\.ts|test/cli\.mjs)'; then
  npm run -s build:cli >/dev/null && node test/cli.mjs > /tmp/ship-cli.log 2>&1 & cli=$!
fi
status=0
wait $e2e || status=1; tail -1 /tmp/ship-e2e.log; grep "✗" -A2 /tmp/ship-e2e.log || true
if [ -n "$cli" ]; then wait $cli || status=1; tail -1 /tmp/ship-cli.log; grep "✗" -A2 /tmp/ship-cli.log || true; fi
echo "shipped in $(( $(date +%s) - start ))s"
exit $status
