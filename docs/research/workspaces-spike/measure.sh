#!/usr/bin/env bash
# Workspaces spike measurements with plain Docker (local Containers dev didn't start here; see WORKSPACES-SPIKE.md).
# Same image as the spike Worker (node:22 + git + sandbox-shim). Prints one line per step: name, seconds.
#   ./measure.sh                                     a public repo over the network
#   REPO_URL=file:///src REPO_MOUNT=/path/to/repo.git ./measure.sh   a local bare mirror (e.g. a private repo)
set -euo pipefail
IMG=atteo-ws-spike:local
REPO_URL=${REPO_URL:-https://github.com/cloudflare/sandbox-sdk.git}
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
docker image inspect "$IMG" >/dev/null 2>&1 || docker build -q -t "$IMG" "$(dirname "$0")" >/dev/null
now() { date +%s.%N; }
lap() { awk -v a="$(now)" -v b="$2" -v n="$1" 'BEGIN{printf "%-34s %6.2fs\n", n, a-b}'; }
run() { docker exec "$C" bash -lc "$1"; }
fresh() {
  local t; t=$(now)
  C=$(docker run -d --rm --memory 4g --cpus 2 -e NPM_CONFIG_UPDATE_NOTIFIER=false ${REPO_MOUNT:+-v "$REPO_MOUNT:/src:ro"} "$IMG" sleep infinity)
  until docker exec "$C" true 2>/dev/null; do sleep 0.05; done
  lap "container start ($1)" "$t"
}
stop() { docker rm -f "$C" >/dev/null; }

echo "== repo: $REPO_URL"
# 1. Cold: new container, clone, npm ci with an empty cache.
fresh cold
t=$(now); run "git config --global --add safe.directory \"*\"; git clone -q --depth 50 $REPO_URL /workspace/repo"; lap "git clone --depth 50" "$t"
t=$(now); run "cd /workspace/repo && npm ci --no-audit --no-fund --loglevel=error >/dev/null"; lap "npm ci (empty cache)" "$t"
run "du -sh /workspace/repo /root/.npm 2>/dev/null | tr '\n' ' '"; echo
# Save what a sleep could keep: the npm cache, and the whole checkout with node_modules.
t=$(now); run "tar -C /root -czf /tmp/npm-cache.tgz .npm"; docker cp -q "$C:/tmp/npm-cache.tgz" "$OUT/npm-cache.tgz"; lap "save npm cache (tgz)" "$t"
t=$(now); run "tar -C /workspace -czf /tmp/ws.tgz repo"; docker cp -q "$C:/tmp/ws.tgz" "$OUT/ws.tgz"; lap "save /workspace (tgz)" "$t"
ls -la "$OUT"/*.tgz | awk '{printf "  %s %.1f MB\n", $9, $5/1048576}'
stop
# 2. Warm cache: new container, clone, restore the npm cache, npm ci --prefer-offline.
fresh "warm cache"
t=$(now); run "git config --global --add safe.directory \"*\"; git clone -q --depth 50 $REPO_URL /workspace/repo"; lap "git clone --depth 50" "$t"
t=$(now); docker cp -q "$OUT/npm-cache.tgz" "$C:/tmp/npm-cache.tgz"; run "tar -C /root -xzf /tmp/npm-cache.tgz"; lap "restore npm cache" "$t"
t=$(now); run "cd /workspace/repo && npm ci --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null"; lap "npm ci (warm cache)" "$t"
stop
# 3. Restore the whole workspace (what DirectoryBackup or a disk snapshot gives back): no clone, no install.
fresh "workspace restore"
t=$(now); docker cp -q "$OUT/ws.tgz" "$C:/tmp/ws.tgz"; run "tar -C /workspace -xzf /tmp/ws.tgz"; lap "restore /workspace" "$t"
t=$(now); run "git config --global --add safe.directory \"*\"; cd /workspace/repo && git fetch -q --depth 50 origin && git status --short | wc -l >/dev/null"; lap "git fetch (catch up)" "$t"
run "cd /workspace/repo && test -d node_modules && echo '  node_modules back, nothing to install'"
stop
