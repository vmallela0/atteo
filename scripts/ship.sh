#!/usr/bin/env bash
# Ship main: run the local suites the change can touch, then push, deploy what changed, and wait until the new version
# is actually serving (no fixed sleep). Production only ever gets health checks from here: no test suites, no test
# data, no load (vedu, Oct 2: "stop making tests that stress test our cloudflare"). Needs CLOUDFLARE_ACCOUNT_ID /
# CLOUDFLARE_API_TOKEN in the environment.
#
# What runs depends on the files changed since the last ship from this repository (jxn #2925: only what the change
# can touch, all at once), through scripts/verify.sh, each suite against its own fresh local server:
#   app code (src/, cli/, migrations/, skills/, the build config…)  vitest + e2e + the browser checks checks-map.json
#                                                                   picks for those files; the CLI suite when CLI-facing
#   landing/                                                        the landing look check + a dry-run build
#   test/ only                                                      just the changed suites (e2e.mjs, cli.mjs, the
#                                                                   changed browser checks, vitest for *.test.ts)
#   ios/, docs/, scripts/, *.md only                                no suites, no deploy: push and a health check
# Then: the app Worker deploys only when app code changed, the landing Worker only when landing/ did.
#   SHIP_FULL=1     every suite, every browser check (the old full landing)
#   SKIP_BROWSER=1  no browser checks (a gate already ran them on exactly this commit)
#   REUSE_DEV=1     e2e (and CLI) against a dev server already up on LOCAL_PORT, as before
#   SHIP_DRY=1      what would run, and run it, then stop before the push (nothing pushed or deployed)
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${BASE:-https://agent-board.vedu-mallela.workers.dev}"
LANDING_BASE="${LANDING_BASE:-https://atteo.dev}"
LOCAL="http://localhost:${LOCAL_PORT:-8788}"
start=$(date +%s)
before=$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD~1)

# 1. What changed since the last ship from this repository (not just since origin/main: another agent may have pushed
# those commits already). The marker lives in the repo's own git dir, which a worktree reaches through git.
LAST_SHIP_FILE="$(git rev-parse --git-common-dir)/atteo-last-ship"
last_ship=${SHIP_BASE:-$(cat "$LAST_SHIP_FILE" 2>/dev/null || echo "$before")} # SHIP_BASE=<ref> overrides it
git cat-file -e "$last_ship" 2>/dev/null || last_ship="$before"
changed=$(git diff --name-only "$last_ship" HEAD)
has() { grep -qE "$1" <<<"$changed"; } # (a here-string: grep -q quitting early can't fail a pipe under pipefail)
# App code: anything the app Worker's build can include. Listed the other way round (what is NOT app code), so a new
# top-level folder counts as app code until someone says otherwise.
app=""; [ -n "$(grep -vE '^(ios/|docs/|landing/|test/|scripts/|\.github/|[^/]+\.md$)' <<<"$changed")" ] && app=1
landing=""; has '^landing/' && landing=1
suites=""
if [ -n "${SHIP_FULL:-}" ]; then
  suites="vitest e2e cli browser"; [ -n "$landing" ] && suites="$suites landing"
else
  if [ -n "$app" ] || has '^test/.*\.ts$'; then suites="vitest"; fi
  if [ -n "$app" ] || has '^test/e2e\.mjs$'; then suites="$suites e2e"; fi
  if has '^(cli/|src/(mcp|secrets|device|auth|index|board|mailbox|sessions)\.ts|test/cli\.mjs)'; then suites="$suites cli"; fi
  if [ -z "${SKIP_BROWSER:-}" ] && { [ -n "$app" ] || has '^test/browser/'; }; then suites="$suites browser"; fi
  [ -n "$landing" ] && suites="$suites landing"
fi
suites=$(echo $suites)
echo "changed since ${last_ship:0:7}: $(echo "$changed" | grep -c . | tr -d ' ') files → ${suites:-no local suites}$([ -n "$app" ] || echo "; no app deploy")$([ -n "$landing" ] && echo "; landing deploy")"

# 2. The suites, locally (local D1 + Durable Objects), all at once through verify.sh, each with its own fresh server.
if [ -n "${REUSE_DEV:-}" ]; then
  CI=1 npx wrangler d1 migrations apply agent-board --local >/tmp/ship-migrate-local.log 2>&1 || { cat /tmp/ship-migrate-local.log; exit 1; }
  (unset ADMIN_KEY; BASE="$LOCAL" node test/e2e.mjs > /tmp/ship-e2e.log 2>&1) || { tail -1 /tmp/ship-e2e.log; grep "✗" -A2 /tmp/ship-e2e.log || true; echo "local suites failed: not shipping"; exit 1; }
  tail -1 /tmp/ship-e2e.log
  if [[ " $suites " == *" cli "* ]]; then
    (npm run -s build:cli >/dev/null && unset ADMIN_KEY && BASE="$LOCAL" node test/cli.mjs > /tmp/ship-cli.log 2>&1) || { tail -1 /tmp/ship-cli.log; grep "✗" -A2 /tmp/ship-cli.log || true; echo "local suites failed: not shipping"; exit 1; }
    tail -1 /tmp/ship-cli.log
  fi
elif [ -n "$suites" ]; then
  # BROWSER_CHANGED narrows the browser checks to what changed (SHIP_FULL runs them all); BASE_REF is the same base.
  VERIFY_PORT=${LOCAL##*:} SUITES="$suites" BASE_REF="$last_ship" \
    BROWSER_CHANGED="$([ -n "${SHIP_FULL:-}" ] || echo "$last_ship")" scripts/verify.sh \
    || { echo "local suites failed: not shipping"; exit 1; }
fi
echo "local suites passed after $(( $(date +%s) - start ))s"
[ -z "${SHIP_DRY:-}" ] || { echo "SHIP_DRY: stopping before the push (nothing pushed or deployed)"; exit 0; }

# 3. Push; then, for app code, migrate (new D1 migrations first, so new code never runs on an old schema) and deploy.
# (No pre-push change card: step 5 posts one for the whole ship, once it's live.)
# (Both names: hooks installed before the rename only know AGENT_SOUP_NO_HOOK.)
ATTEO_NO_HOOK=1 AGENT_SOUP_NO_HOOK=1 git push -q origin HEAD:main
ver=""
if [ -n "$app" ]; then
  CI=1 npx wrangler d1 migrations apply agent-board --remote >/tmp/ship-migrate.log 2>&1 || { cat /tmp/ship-migrate.log; exit 1; }
  grep -q "No migrations to apply" /tmp/ship-migrate.log || grep -E "✅|applied" /tmp/ship-migrate.log | sed 's/^/migrated: /'
  out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
  ver=$(echo "$out" | sed -nE 's/.*Current Version ID: ([0-9a-f-]+).*/\1/p')
  echo "deployed $ver"
fi
if [ -n "$landing" ]; then
  out=$(npx wrangler deploy -c landing/wrangler.jsonc 2>&1) || { echo "$out"; exit 1; }
  echo "deployed the landing Worker $(echo "$out" | sed -nE 's/.*Current Version ID: ([0-9a-f-]+).*/\1/p')"
fi

# 4. Production: rollouts reach instances gradually, so after an app deploy wait for 6 health checks in a row on the new
# version; then one deep check (database + a board answering), deploy or not. That's all prod gets.
if [ -n "$ver" ]; then
  ok=0
  for i in $(seq 1 240); do
    if [ "$(curl -s "$BASE/health" | sed -nE 's/.*"version":"([^"]*)".*/\1/p')" = "$ver" ]; then ok=$((ok + 1)); else ok=0; fi
    [ "$ok" -ge 6 ] && break
    sleep 0.5
  done
  echo "live after $(( $(date +%s) - start ))s"
fi
deep=$(curl -s "$BASE/health/deep")
echo "$deep" | grep -q '"ok":true' || { echo "deep health check failed: $deep"; exit 1; }
if [ -n "$landing" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$LANDING_BASE/robots.txt")
  [ "$code" = 200 ] || { echo "landing check failed: $LANDING_BASE/robots.txt answered $code"; exit 1; }
fi
echo "prod healthy; shipped in $(( $(date +%s) - start ))s"
git rev-parse HEAD > "$LAST_SHIP_FILE" || echo "couldn't record the ship in $LAST_SHIP_FILE (the next ship tests more than it needs)"

# 5. A change card of what just shipped (before..HEAD) on the build board, with the installed CLI (and its login).
# Flags the CLI has had since change cards came in, so an atteo older than this repo still works (and agent-soup,
# its name before the rename, when that's all that's installed). Never fails the ship, and prints only the entry
# number: the CLI's other output can quote other people's board messages.
atteo=$(command -v atteo || command -v agent-soup || true)
if [ "$before" != "$(git rev-parse HEAD)" ] && [ -n "$atteo" ]; then
  n=$(git rev-list --count "$before"..HEAD 2>/dev/null || echo "?")
  title=$([ -n "$ver" ] && echo "Shipped to production" || echo "Pushed to main (nothing to deploy)")
  what=$([ -n "$ver" ] && echo "Shipped to production ($ver)" || echo "Pushed to main, no app change to deploy")
  ship_card() {
    ATTEO_NO_UPDATE_CHECK=1 AGENT_SOUP_NO_UPDATE_CHECK=1 "$atteo" card --base "$before" --committed --no-gh --board "${SHIP_BOARD:-b_skyvcqtm7fei}" \
      --title "$title" --post "$what: $n commit$([ "$n" = 1 ] || echo s)" 2>/dev/null
  }
  # Exit 2: others posted since this session last read (now marked read); the card still fits, so post it again.
  rc=0; card=$(ship_card) || rc=$?
  if [ "$rc" = 2 ]; then card=$(ship_card) || true; fi
  echo "$card" | grep -oE 'Posted #[0-9]+' | sed 's/^Posted/change card posted:/' || echo "change card not posted (the ship is done)"
fi
exit 0
