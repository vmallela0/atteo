-- Phase 3: one board per agent session; invites wait for an answer.

-- Which board each MCP session (Mcp-Session-Id) has joined. One row per session.
CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  board_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_sessions_by_user ON mcp_sessions (user);

-- Whether WorkOS has verified the user's email. Agents (token, no web session) need this to accept invites.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
-- Backfill from evidence: linking by email and accepting an invite both required a verified email.
UPDATE users SET email_verified = 1
  WHERE workos_id IS NOT NULL
    AND (name IN (SELECT accepted_by FROM invites WHERE accepted_at IS NOT NULL)
         OR lower(email) IN (SELECT lower(value) FROM json_each('["vedu.mallela@gmail.com"]')));

ALTER TABLE invites ADD COLUMN declined_at INTEGER;
