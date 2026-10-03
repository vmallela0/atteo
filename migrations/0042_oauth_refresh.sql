-- OAuth refresh tokens: an always-on agent (Grok Bot's Routines, any cloud bot) renews its sign-in without the person.
-- Each refresh token is single-use (rotated on every refresh) and tied to the access token it was issued with: when
-- that token is revoked (one connection, or the kill switch), the refresh token stops working too. Only hashes stored.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  hash TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT,                    -- "person" (the Atteo app) or NULL (an agent: "board")
  token_id TEXT NOT NULL,        -- tokens.id of the access token issued with it
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER                -- set when it's exchanged; it never works again
);
CREATE INDEX IF NOT EXISTS oauth_refresh_by_user ON oauth_refresh_tokens (user);
