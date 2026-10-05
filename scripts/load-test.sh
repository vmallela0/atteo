#!/usr/bin/env bash
# One-command local 10k load test (GAPS non-functional). Starts a throwaway wrangler, seeds N entries
# (default 10,000), prints p50/p95 including post→wait and context pack, writes JSON, then stops the
# Worker. Never production. Against a Worker you already started: docs/LOAD_TEST.md.
#
#   scripts/load-test.sh
#   SMOKE=1 scripts/load-test.sh
#   OUT=load-test.json scripts/load-test.sh
#   N=10000 RUNS=20 scripts/load-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

port=""
for candidate in {8860..8869}; do
  if PORT="$candidate" python3 -c 'import os,socket; s=socket.socket(); s.bind(("127.0.0.1", int(os.environ["PORT"])))' 2>/dev/null; then
    port=$candidate
    break
  fi
done
if [[ -z "$port" ]]; then echo "No free port in 8860-8869" >&2; exit 1; fi

state=$(mktemp -d /tmp/atteo-load.XXXXXX)
. scripts/procgroups.sh
cleanup() {
  trap - EXIT INT TERM
  stop_groups 5
  lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  rm -rf "$state"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'WORKOS_API_KEY=sk_test_ci_placeholder\nADMIN_KEY=ci-admin-key\nPOSTS_PER_MINUTE=100000\nPUBLIC_URL=http://localhost:%s\n' "$port" > "$state/load.env"
if ! CI=1 npx wrangler d1 migrations apply agent-board --local --persist-to "$state" >"$state/migrate.log" 2>&1; then
  cat "$state/migrate.log" >&2
  exit 1
fi
in_group bash -c 'exec npx wrangler dev --port "$1" --inspector-port $(($1 + 1000)) --persist-to "$2" --env-file "$2/load.env" >"$2/dev.log" 2>&1' _ "$port" "$state"

for ((i = 0; i < 240; i++)); do
  if curl --silent --fail --output /dev/null "http://localhost:$port/health"; then
    break
  fi
  if ! kill -0 "$group_pid" 2>/dev/null; then
    cat "$state/dev.log" >&2
    exit 1
  fi
  sleep 0.25
done
if ! curl --silent --fail --output /dev/null "http://localhost:$port/health"; then
  echo "Worker did not become healthy on port $port" >&2
  cat "$state/dev.log" >&2
  exit 1
fi

echo "load-test: throwaway Worker on http://localhost:$port (POSTS_PER_MINUTE=100000)"
export BASE="http://localhost:$port"
export ADMIN_KEY=ci-admin-key
export OUT="${OUT:-/tmp/atteo-load-report.json}"
node scripts/load-test.mjs
echo "report: $OUT"
