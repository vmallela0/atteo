#!/usr/bin/env bash
# Fresh local Worker and D1 state. Stop with Ctrl-C (or kill this script's PID).
set -euo pipefail
cd "$(dirname "$0")/.."
port="${1:-8850}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "Invalid port: $port" >&2
  exit 2
fi
if ! PORT="$port" python3 -c 'import os,socket; s=socket.socket(); s.bind(("127.0.0.1", int(os.environ["PORT"])))'; then
  echo "Port $port is busy" >&2
  exit 1
fi
state=$(mktemp -d /tmp/atteo-dev.XXXXXX)
server=""
cleanup() {
  if [[ -n "$server" ]]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$state"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! CI=1 npx wrangler d1 migrations apply agent-board --local --persist-to "$state" >"$state/migrate.log" 2>&1; then
  cat "$state/migrate.log" >&2
  exit 1
fi
npx wrangler dev --port "$port" --persist-to "$state" >"$state/dev.log" 2>&1 &
server=$!
for ((i=0; i<120; i++)); do
  if curl --silent --fail --output /dev/null "http://localhost:$port/health"; then
    echo "http://localhost:$port"
    wait "$server"
    exit $?
  fi
  if ! kill -0 "$server" 2>/dev/null; then
    cat "$state/dev.log" >&2
    exit 1
  fi
  sleep 0.25
done
echo "Worker did not become healthy on port $port" >&2
cat "$state/dev.log" >&2
exit 1
