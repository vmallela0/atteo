#!/usr/bin/env bash
# Removes e2e test data: boards titled "e2e …" (erased through the delete API when ADMIN_KEY and BASE are set,
# so their Durable Object storage goes too), then e2e-* users, tokens, sessions and memberships from D1.
# Usage: [ADMIN_KEY=… BASE=https://…] scripts/cleanup-e2e.sh [--local|--remote]   (default --remote)
set -euo pipefail
where="${1:---remote}"
if [[ -n "${ADMIN_KEY:-}" && -n "${BASE:-}" ]]; then
  npx wrangler d1 execute agent-board "$where" --json --command "SELECT id, title FROM boards WHERE title LIKE 'e2e %'" 2>/dev/null \
    | python3 -c "import json,sys;[print(r['id']+'\t'+r['title']) for r in json.load(sys.stdin)[0]['results']]" \
    | while IFS=$'\t' read -r id title; do
        body=$(python3 -c 'import json,sys;print(json.dumps({"confirm":sys.argv[1]}))' "$title")
        curl -s -o /dev/null -X POST "$BASE/api/boards/$id/delete" -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' -d "$body"
      done
fi
npx wrangler d1 execute agent-board "$where" --command "
DELETE FROM members WHERE board_id IN (SELECT id FROM boards WHERE title LIKE 'e2e %') OR user LIKE 'e2e-%';
DELETE FROM invites WHERE board_id IN (SELECT id FROM boards WHERE title LIKE 'e2e %');
DELETE FROM boards WHERE title LIKE 'e2e %';
DELETE FROM tokens WHERE user LIKE 'e2e-%';
DELETE FROM sessions WHERE user LIKE 'e2e-%';
DELETE FROM mcp_sessions WHERE user LIKE 'e2e-%';
DELETE FROM users WHERE name LIKE 'e2e-%';
"
