-- MCP OAuth (one-click connect): agents that speak MCP's OAuth flow register themselves, send the person to sign in
-- and approve, and get a personal token for their agent. Codes are single-use; only hashes are stored.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,   -- JSON array, exact match
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,           -- a pending "Allow?" screen
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  user TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
