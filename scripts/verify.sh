#!/usr/bin/env bash
# Everything a landing checks, at once (vedu #2791: iteration speed). Boots the local servers once, in parallel, then
# runs the suites concurrently instead of one after another:
#   vitest   (no server)
#   e2e      own server :PORT     (the repo's .dev.vars, as ship.sh always used)
#   cli      own server :PORT+1   (same .dev.vars; only when CLI-facing code changed, or ALL=1)
#   browser  own server :PORT+2   (CI-style values from an --env-file: ADMIN_KEY=ci-admin-key, DEV_FAKE_*, as CI)
#   backup   own server :PORT+4   (backup vars from an --env-file: a fake S3 on :PORT+5, run by test/backup.mjs)
#   landing  the landing Worker :PORT+3 (its look check, then a dry-run build); only when SUITES names it
# Each server has its own --persist-to state, so no suite loads another's server (sharing one made the slower suite
# flake). Prints one summary and exits non-zero if any suite failed. Logs: $VERIFY_DIR/<suite>.log.
#
#   scripts/verify.sh                 # all suites (cli only if CLI-facing code changed since BASE_REF)
#   SUITES="e2e browser" scripts/verify.sh
#   BROWSER_CHANGED=origin/main scripts/verify.sh   # only the browser checks the changes since origin/main need
#   SHIP_FULL=1 scripts/ship.sh       # a landing in one step: this, then push and deploy
#
# Env: VERIFY_PORT (default 8610; uses PORT..PORT+3) · SUITES (default "vitest e2e cli browser"; naming cli always runs
#   it) · ALL=1 (run cli regardless) · BASE_REF (what "changed" means for the cli rule; default the last ship, else
#   origin/main) · BROWSER_CHANGED (a ref: run only the browser checks checks-map.json picks for the files changed
#   since it; when it picks none, the browser server isn't started either) · VERIFY_DIR (logs and state; default
#   <tmp>/atteo-verify) · PAR / BROWSERS / RETRY (read by test/browser/run.mjs) · CLI_PAR (read by test/cli.mjs).
# Local only: every server here is a localhost wrangler dev; production never gets these suites.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=${VERIFY_PORT:-8610}
E2E_PORT=$PORT; CLI_PORT=$((PORT + 1)); BR_PORT=$((PORT + 2)); LANDING_PORT=$((PORT + 3)); BK_PORT=$((PORT + 4)); BK_S3_PORT=$((PORT + 5))
OUT=${VERIFY_DIR:-${TMPDIR:-/tmp}/atteo-verify}; OUT=${OUT%/}
# The last ship's commit, kept in the repository's own git dir (in a worktree .git is a file: ask git where it is).
LAST_SHIP_FILE="$(git rev-parse --git-common-dir)/atteo-last-ship"
asked=${SUITES:-}
SUITES=" ${SUITES:-vitest e2e cli browser} "
want() { [[ "$SUITES" == *" $1 "* ]]; }
start=$(date +%s)
mkdir -p "$OUT"

# The CLI suite only matters when CLI-facing code changed (the same rule ship.sh has always used). SUITES naming cli
# (as ship.sh does, from its own rule) runs it regardless.
if want cli && [ -z "${ALL:-}" ] && [ -z "$asked" ]; then
  ref=${BASE_REF:-$(cat "$LAST_SHIP_FILE" 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo HEAD~1)}
  git cat-file -e "$ref" 2>/dev/null || ref=$(git rev-parse origin/main 2>/dev/null || echo HEAD~1)
  if ! git diff --name-only "$ref" HEAD | grep -qE '^(cli/|src/(mcp|secrets|device|auth|index|board|mailbox|sessions)\.ts|test/cli\.mjs)'; then
    SUITES=${SUITES/ cli / }; echo "cli: skipped (no CLI-facing change since ${ref:0:7}; ALL=1 runs it)"
  fi
fi

# BROWSER_CHANGED: only the checks the change needs (checks-map.json); none needed means no browser server either.
browser_args=()
if want browser && [ -n "${BROWSER_CHANGED:-}" ]; then
  pick=$(node test/browser/run.mjs --changed "$BROWSER_CHANGED" --list 2>&1 | tail -1)
  if [ "$pick" = "no browser checks needed" ]; then
    SUITES=${SUITES/ browser / }; echo "browser: skipped (no check covers what changed since ${BROWSER_CHANGED:0:7})"
  else
    browser_args=(--changed "$BROWSER_CHANGED"); echo "browser: $(echo "$pick" | wc -w | tr -d ' ') checks for what changed since ${BROWSER_CHANGED:0:7}"
  fi
fi

pids=(); ports=()
# The servers this run started, and whatever is still listening on their ports (wrangler's workerd can outlive npx).
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  for port in "${ports[@]:-}"; do [ -n "$port" ] && lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null; done
  return 0
}
trap cleanup EXIT INT TERM

busy() { curl -s -o /dev/null --max-time 2 "http://localhost:$1/health"; }
# serve <name> <port> [env file]: migrate a fresh state dir and start wrangler dev on it, in the background. The env
# file, when given, replaces .dev.vars for that server (wrangler reads one or the other, never both).
serve() {
  local name=$1 port=$2 envf=${3:-} dir="$OUT/state-$1"
  if busy "$port"; then echo "port $port is busy: stop that server or set VERIFY_PORT" >&2; exit 2; fi
  rm -rf "$dir"
  ( CI=1 npx wrangler d1 migrations apply agent-board --local --persist-to "$dir" >"$OUT/$name.migrate.log" 2>&1 \
      || { echo "migrations failed for $name (log: $OUT/$name.migrate.log)" >&2; exit 1; }
    exec npx wrangler dev --port "$port" --persist-to "$dir" ${envf:+--env-file "$envf"} >"$OUT/$name.server.log" 2>&1 ) &
  pids+=($!); ports+=("$port"); eval "pid_$name=$!"
}
# up <port> <name> [path]: wait for it to answer; give up at once if the server (or its migration) already died.
up() {
  local pid; eval "pid=\$pid_$2"
  for _ in $(seq 1 240); do
    curl -s -o /dev/null --max-time 2 "http://localhost:$1${3:-/health}" && return 0
    kill -0 "$pid" 2>/dev/null || { echo "the $2 server on :$1 exited (log: $OUT/$2.server.log)" >&2; exit 2; }
    sleep 0.5
  done
  echo "the $2 server on :$1 didn't start (log: $OUT/$2.server.log)" >&2; exit 2
}

# 1. Servers, all at once (migrations included), plus the CLI build the cli and browser suites need.
want e2e && serve e2e "$E2E_PORT"
want cli && serve cli "$CLI_PORT"
if want browser; then
  printf 'WORKOS_API_KEY=sk_test_ci_placeholder\nADMIN_KEY=ci-admin-key\nPOSTS_PER_MINUTE=100000\nALLOW_LOCAL_WEBHOOKS=1\nDEV_FAKE_CLOCK=1\nDEV_FAKE_VOICE=1\nDEV_FAKE_NEAR_QUOTA=1\nPUBLIC_URL=http://localhost:%s\n' "$BR_PORT" > "$OUT/browser.env"
  serve browser "$BR_PORT" "$OUT/browser.env"
fi
if want landing; then
  # The landing Worker on its own: it forwards everything else to APP_ORIGIN, which nothing here needs (the look
  # check answers /fonts/* itself), so that points nowhere.
  if busy "$LANDING_PORT"; then echo "port $LANDING_PORT is busy: stop that server or set VERIFY_PORT" >&2; exit 2; fi
  ( exec npx wrangler dev -c landing/wrangler.jsonc --port "$LANDING_PORT" --var "APP_ORIGIN:http://127.0.0.1:9" >"$OUT/landing.server.log" 2>&1 ) &
  pids+=($!); ports+=("$LANDING_PORT"); pid_landing=$!
fi
if want backup; then
  # The backup key pair (the private key stays in $OUT for the drill to decrypt with) and the env it needs: the Worker
  # with backups on, pointed at the fake S3 test/backup.mjs starts on :BK_S3_PORT.
  BK_KEY_FILE="$OUT/backup-key.json"
  node scripts/backup.mjs keygen --out "$BK_KEY_FILE" >"$OUT/backup-keygen.log" 2>&1 || { echo "backup keygen failed (log: $OUT/backup-keygen.log)" >&2; exit 1; }
  BK_PUB=$(sed -n 's/.*BACKUP_PUBLIC_KEY: "\(.*\)".*/\1/p' "$OUT/backup-keygen.log")
  printf 'WORKOS_API_KEY=sk_test_ci_placeholder\nADMIN_KEY=ci-admin-key\nALLOW_LOCAL_WEBHOOKS=1\nBACKUP_S3_ENDPOINT=http://127.0.0.1:%s\nBACKUP_S3_BUCKET=atteo-test\nBACKUP_S3_REGION=us-east-1\nBACKUP_S3_KEY_ID=test\nBACKUP_S3_SECRET=test\nBACKUP_S3_PREFIX=\nBACKUP_PUBLIC_KEY=%s\n' "$BK_S3_PORT" "$BK_PUB" > "$OUT/backup.env"
  serve backup "$BK_PORT" "$OUT/backup.env"
fi
if want cli || want browser; then npm run -s build:cli >"$OUT/build-cli.log" 2>&1 || { echo "CLI build failed (log: $OUT/build-cli.log)" >&2; exit 1; }; fi
want e2e && up "$E2E_PORT" e2e
want cli && up "$CLI_PORT" cli
want browser && up "$BR_PORT" browser
want landing && up "$LANDING_PORT" landing /robots.txt
want backup && up "$BK_PORT" backup
echo "servers up after $(( $(date +%s) - start ))s"

# 2. The suites, concurrently. Each writes $OUT/<suite>.log and $OUT/<suite>.rc (exit code) and .secs.
run() { # run <suite> <command...>
  local name=$1; shift
  ( s=$(date +%s); "$@" >"$OUT/$name.log" 2>&1; rc=$?; echo $rc >"$OUT/$name.rc"; echo $(( $(date +%s) - s )) >"$OUT/$name.secs" ) &
  pids+=($!); suite_pids+=($!)
}
landing_suite() { LANDING="http://localhost:$LANDING_PORT" node test/browser/landing-look.mjs && npx wrangler deploy -c landing/wrangler.jsonc --dry-run --outdir "$OUT/landing-build"; }
suite_pids=()
want vitest && run vitest npx vitest run
want e2e && run e2e env -u ADMIN_KEY BASE="http://localhost:$E2E_PORT" DEV_LOG="$OUT/e2e.server.log" node test/e2e.mjs
want cli && run cli env -u ADMIN_KEY BASE="http://localhost:$CLI_PORT" node test/cli.mjs
want browser && run browser env PERSIST="$OUT/state-browser" ADMIN_KEY=ci-admin-key BASE="http://localhost:$BR_PORT" SHOTS_DIR="$OUT/browser-shots" node test/browser/run.mjs "${browser_args[@]}"
want landing && run landing landing_suite
want backup && run backup env BASE="http://localhost:$BK_PORT" ADMIN_KEY=ci-admin-key BK_S3_PORT="$BK_S3_PORT" BK_KEY_FILE="$OUT/backup-key.json" node test/backup.mjs
for p in "${suite_pids[@]}"; do wait "$p"; done

# 3. One summary.
status=0
echo
for name in vitest e2e cli browser backup landing; do
  want "$name" || continue
  rc=$(cat "$OUT/$name.rc" 2>/dev/null || echo 1); t=$(cat "$OUT/$name.secs" 2>/dev/null || echo "?")
  case $name in
    vitest) res=$(grep -E "Tests +[0-9]" "$OUT/$name.log" | tail -1 | sed -E 's/ +/ /g') ;;
    browser) res=$(grep -E "browser checks passed" "$OUT/$name.log" | tail -1) ;;
    landing) res=$(grep -E "landing look|FAILED" "$OUT/$name.log" | tail -1) ;;
    backup) res=$(grep -E "passed, [0-9]+ failed" "$OUT/$name.log" | tail -1) ;;
    *) res=$(grep -E "passed, [0-9]+ failed" "$OUT/$name.log" | tail -1) ;;
  esac
  [ "$rc" = 0 ] && mark="ok  " || { mark="FAIL"; status=1; }
  printf '%s %-8s %4ss  %s\n' "$mark" "$name" "$t" "${res:-(see $OUT/$name.log)}"
  if [ "$rc" != 0 ]; then
    case $name in
      e2e|cli) grep -A2 "✗" "$OUT/$name.log" | head -20 ;;
      browser) grep -E "^FAILED|^  [a-z0-9-]+: " "$OUT/$name.log" | head -20 ;;
      landing) grep -E "✗|rror" "$OUT/$name.log" | head -20 ;;
      vitest) grep -E "FAIL|×" "$OUT/$name.log" | head -20 ;;
    esac
  fi
done
echo "verify: $([ $status = 0 ] && echo passed || echo FAILED) in $(( $(date +%s) - start ))s (logs: $OUT)"
exit $status
