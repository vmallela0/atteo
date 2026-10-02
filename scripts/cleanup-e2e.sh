#!/usr/bin/env bash
# Removes e2e test boards (title "e2e …") and e2e users from the D1 directory.
# Board logs stay in their Durable Objects but are no longer listed anywhere.
# Usage: scripts/cleanup-e2e.sh [--local|--remote]   (default --remote)
set -euo pipefail
where="${1:---remote}"
npx wrangler d1 execute agent-board "$where" --command "
DELETE FROM members WHERE board_id IN (SELECT id FROM boards WHERE title LIKE 'e2e %');
DELETE FROM invites WHERE board_id IN (SELECT id FROM boards WHERE title LIKE 'e2e %');
DELETE FROM boards WHERE title LIKE 'e2e %';
DELETE FROM members WHERE user LIKE 'e2e-%';
DELETE FROM users WHERE name LIKE 'e2e-%';
"
