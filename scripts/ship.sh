#!/usr/bin/env bash
# Ship main: run the e2e suite (and the CLI suite, if CLI-related code changed) against a LOCAL server first, then
# push, deploy, and wait until the new version is actually serving (no fixed sleep). Production only ever gets health
# checks from here: no test suites, no test data, no load (vedu, Oct 2: "stop making tests that stress test our
# cloudflare"). Needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in the environment.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${BASE:-https://agent-board.vedu-mallela.workers.dev}"
LOCAL="http://localhost:${LOCAL_PORT:-8788}"
start=$(date +%s)
before=$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD~1)

# 1. The suites, locally (local D1 + Durable Objects; the ADMIN_KEY in .dev.vars). Reuse a dev server if one is up.
dev=""
if ! curl -s -o /dev/null "$LOCAL/health"; then
  npx wrangler dev --port "${LOCAL##*:}" >/tmp/ship-dev.log 2>&1 & dev=$!
  trap '[ -n "$dev" ] && kill $dev 2>/dev/null; true' EXIT
  for i in $(seq 1 120); do curl -s -o /dev/null "$LOCAL/health" && break; sleep 0.5; done
fi
CI=1 npx wrangler d1 migrations apply agent-board --local >/tmp/ship-migrate-local.log 2>&1 || { cat /tmp/ship-migrate-local.log; exit 1; }
(unset ADMIN_KEY; BASE="$LOCAL" node test/e2e.mjs > /tmp/ship-e2e.log 2>&1) & e2e=$!
cli=""
if git diff --name-only "$before" HEAD | grep -qE '^(cli/|src/(mcp|secrets|device|auth|index|board)\.ts|test/cli\.mjs)'; then
  (npm run -s build:cli >/dev/null && unset ADMIN_KEY && BASE="$LOCAL" node test/cli.mjs > /tmp/ship-cli.log 2>&1) & cli=$!
fi
status=0
wait $e2e || status=1; tail -1 /tmp/ship-e2e.log; grep "✗" -A2 /tmp/ship-e2e.log || true
if [ -n "$cli" ]; then wait $cli || status=1; tail -1 /tmp/ship-cli.log; grep "✗" -A2 /tmp/ship-cli.log || true; fi
[ "$status" = 0 ] || { echo "local suites failed: not shipping"; exit 1; }
echo "local suites passed after $(( $(date +%s) - start ))s"

# 2. Push, migrate (new D1 migrations first, so new code never runs on an old schema), deploy.
# (No pre-push change card: step 4 posts one for the whole ship, once it's live.)
AGENT_SOUP_NO_HOOK=1 git push -q origin HEAD:main
CI=1 npx wrangler d1 migrations apply agent-board --remote >/tmp/ship-migrate.log 2>&1 || { cat /tmp/ship-migrate.log; exit 1; }
grep -q "No migrations to apply" /tmp/ship-migrate.log || grep -E "✅|applied" /tmp/ship-migrate.log | sed 's/^/migrated: /'
out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
ver=$(echo "$out" | sed -nE 's/.*Current Version ID: ([0-9a-f-]+).*/\1/p')
echo "deployed $ver"

# 3. Production: rollouts reach instances gradually, so wait for 6 health checks in a row on the new version,
# then one deep check (database + a board answering). That's all prod gets.
ok=0
for i in $(seq 1 240); do
  if [ "$(curl -s "$BASE/health" | sed -nE 's/.*"version":"([^"]*)".*/\1/p')" = "$ver" ]; then ok=$((ok + 1)); else ok=0; fi
  [ "$ok" -ge 6 ] && break
  sleep 0.5
done
echo "live after $(( $(date +%s) - start ))s"
deep=$(curl -s "$BASE/health/deep")
echo "$deep" | grep -q '"ok":true' || { echo "deep health check failed: $deep"; exit 1; }
echo "prod healthy; shipped in $(( $(date +%s) - start ))s"

# 4. A change card of what just shipped (before..HEAD) on the build board, with the installed CLI (and its login).
# Flags the CLI has had since change cards came in, so an agent-soup older than this repo still works. Never fails
# the ship, and prints only the entry number: the CLI's other output can quote other people's board messages.
if [ "$before" != "$(git rev-parse HEAD)" ] && command -v agent-soup >/dev/null 2>&1; then
  n=$(git rev-list --count "$before"..HEAD 2>/dev/null || echo "?")
  ship_card() {
    AGENT_SOUP_NO_UPDATE_CHECK=1 agent-soup card --base "$before" --committed --no-gh --board "${SHIP_BOARD:-b_skyvcqtm7fei}" \
      --title "Shipped to production" --post "Shipped to production ($ver): $n commit$([ "$n" = 1 ] || echo s)" 2>/dev/null
  }
  # Exit 2: others posted since this session last read (now marked read); the card still fits, so post it again.
  rc=0; card=$(ship_card) || rc=$?
  if [ "$rc" = 2 ]; then card=$(ship_card) || true; fi
  echo "$card" | grep -oE 'Posted #[0-9]+' | sed 's/^Posted/change card posted:/' || echo "change card not posted (the ship is done)"
fi
