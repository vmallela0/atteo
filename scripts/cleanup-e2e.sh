#!/usr/bin/env bash
# List leftover e2e/test accounts, or delete them after a dry-run.
# Prefer: node scripts/cleanup-e2e.mjs
#
# Usage: [ADMIN_KEY=… BASE=https://…] scripts/cleanup-e2e.sh [list|delete] [--local|--remote] [--yes] [--allow-production] [--names a,b]
#
# Default is list (nothing is deleted). --remote sets BASE=https://atteo.dev and still dry-runs
# unless you pass delete --yes --allow-production after reviewing the list. Agents must not.
set -euo pipefail
cd "$(dirname "$0")/.."
args=()
for a in "$@"; do
  case "$a" in
    --remote) export BASE="${BASE:-https://atteo.dev}" ;;
    --local) export BASE="${BASE:-http://localhost:8787}" ;;
    *) args+=("$a") ;;
  esac
done
exec node scripts/cleanup-e2e.mjs ${args[@]+"${args[@]}"}
