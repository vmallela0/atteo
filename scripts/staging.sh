#!/usr/bin/env bash
# Staging (vedu #6570, docs/STAGING.md): deploy the current checkout to the atteo-staging Worker (its own D1, Durable
# Objects and rate-limit counter; nothing shared with prod), apply D1 migrations to the staging DB, wait until the new
# version serves, then a short smoke test (scripts/staging-smoke.mjs). Prod is never touched: every wrangler call here
# carries --env staging, and ship.sh keeps deploying only the top level of wrangler.jsonc.
#   STAGING_SKIP_DEPLOY=1  smoke-test what's already there
#   STAGING_BENCH=1        then scripts/bench-messaging.mjs against staging, when that script exists (light load only)
# ADMIN_KEY for staging is a random value of its own, kept outside the repo in the git dir (mode 600). First run, or
# when the file is missing, makes a fresh one and puts it on the Worker. It is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${STAGING_BASE:-https://atteo-staging.vedu-mallela.workers.dev}"
KEY_FILE="$(git rev-parse --git-common-dir)/atteo-staging-admin-key"
start=$(date +%s)
log=$(mktemp -t atteo-staging.XXXXXX)
W() { npx wrangler "$@" --env staging; }

if [ -z "${STAGING_SKIP_DEPLOY:-}" ]; then
  # Migrations first, so new code never runs on an old schema (as ship.sh does for prod). D1 sometimes answers 7403 for
  # a moment: three tries.
  for try in 1 2 3; do CI=1 W d1 migrations apply agent-board-staging --remote >"$log" 2>&1 && break
    [ $try = 3 ] && { cat "$log"; exit 1; }; sleep 5; done
  grep -q "No migrations to apply" "$log" || echo "migrated: $(grep -oE '[0-9]{4}_[A-Za-z0-9_-]+\.sql' "$log" | sort -u | wc -l | tr -d ' ') migration(s)"
  out=$(W deploy 2>&1) || { echo "$out"; exit 1; }
  ver=$(echo "$out" | sed -nE 's/.*Current Version ID: ([0-9a-f-]+).*/\1/p')
  echo "deployed $ver to $BASE"
  # Wait until the new version answers 3 times in a row (rollouts reach instances gradually).
  ok=0
  for i in $(seq 1 120); do
    if [ "$(curl -s "$BASE/health" | sed -nE 's/.*"version":"([^"]*)".*/\1/p')" = "$ver" ]; then ok=$((ok + 1)); else ok=0; fi
    [ "$ok" -ge 3 ] && break
    sleep 0.5
  done
  [ "$ok" -ge 3 ] || { echo "staging never served $ver"; exit 1; }
  echo "live after $(( $(date +%s) - start ))s"
fi

# The staging ADMIN_KEY: fresh random, never prod's, never printed.
if [ ! -s "$KEY_FILE" ]; then
  (umask 077; openssl rand -hex 32 | tr -d '\n' > "$KEY_FILE")
  W secret put ADMIN_KEY < "$KEY_FILE" >"$log" 2>&1 || { cat "$log"; rm -f "$KEY_FILE"; exit 1; }
  echo "set a new staging ADMIN_KEY (kept in $KEY_FILE)"
  sleep 5 # a secret change is a new version; let it reach the edge
fi

ADMIN_KEY="$(cat "$KEY_FILE")" BASE="$BASE" node scripts/staging-smoke.mjs

if [ -n "${STAGING_BENCH:-}" ]; then
  if [ -f scripts/bench-messaging.mjs ]; then ADMIN_KEY="$(cat "$KEY_FILE")" node scripts/bench-messaging.mjs --base "$BASE"
  else echo "STAGING_BENCH: scripts/bench-messaging.mjs isn't in this checkout; skipped"; fi
fi
echo "staging ok in $(( $(date +%s) - start ))s: $BASE"
