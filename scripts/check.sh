#!/usr/bin/env bash
# Fast local checks; ONLY also runs a focused end-to-end slice on a fresh Worker.
set -euo pipefail
cd "$(dirname "$0")/.."
start=$(date +%s)
type_time=0
test_time=0
e2e_time=0
cli_time=0
status=0
dev=""
logs=$(mktemp -d /tmp/atteo-check.XXXXXX)
cleanup() {
  if [[ -n "$dev" ]]; then
    kill "$dev" 2>/dev/null || true
    wait "$dev" 2>/dev/null || true
  fi
  rm -rf "$logs"
  echo "check: $([[ "$status" == 0 ]] && echo PASS || echo FAIL) | tsc ${type_time}s | vitest ${test_time}s | e2e ${e2e_time}s | cli ${cli_time}s | total $(( $(date +%s) - start ))s"
}
trap cleanup EXIT
trap 'status=1; exit 130' INT
trap 'status=1; exit 143' TERM

( t=$(date +%s); rc=0; npx tsc --noEmit -p . >"$logs/tsc.log" 2>&1 || rc=$?; echo "$(( $(date +%s) - t ))" >"$logs/tsc.time"; exit "$rc" ) & type_pid=$!
( t=$(date +%s); rc=0; npx vitest run >"$logs/vitest.log" 2>&1 || rc=$?; echo "$(( $(date +%s) - t ))" >"$logs/vitest.time"; exit "$rc" ) & test_pid=$!
wait "$type_pid" || { cat "$logs/tsc.log"; status=1; }
wait "$test_pid" || { cat "$logs/vitest.log"; status=1; }
type_time=$(cat "$logs/tsc.time")
test_time=$(cat "$logs/vitest.time")
if [[ "$status" != 0 ]]; then exit 1; fi

if [[ -n "${ONLY:-}" ]]; then
  port=""
  for candidate in {8850..8859}; do
    if PORT="$candidate" python3 -c 'import os,socket; s=socket.socket(); s.bind(("127.0.0.1", int(os.environ["PORT"])))' 2>/dev/null; then
      port=$candidate
      break
    fi
  done
  if [[ -z "$port" ]]; then echo "No free port in 8850-8859" >&2; status=1; exit 1; fi
  scripts/dev.sh "$port" >"$logs/dev.log" 2>&1 & dev=$!
  for ((i=0; i<240; i++)); do
    if curl --silent --fail --output /dev/null "http://localhost:$port/health"; then break; fi
    if ! kill -0 "$dev" 2>/dev/null; then cat "$logs/dev.log" >&2; status=1; exit 1; fi
    sleep 0.25
  done
  if ! curl --silent --fail --output /dev/null "http://localhost:$port/health"; then
    cat "$logs/dev.log" >&2; status=1; exit 1
  fi
  echo "Focused e2e: ONLY=$ONLY at http://localhost:$port"
  t=$(date +%s)
  if ! BASE="http://localhost:$port" node test/e2e.mjs; then status=1; fi
  e2e_time=$(( $(date +%s) - t ))
  if [[ "${CLI:-}" == 1 ]]; then
    t=$(date +%s)
    if ! npm run -s build:cli || ! BASE="http://localhost:$port" node test/cli.mjs; then status=1; fi
    cli_time=$(( $(date +%s) - t ))
  fi
fi
exit "$status"
