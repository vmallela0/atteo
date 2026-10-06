-- OAuth clients (MCP dynamic registration): POST /oauth/register inserts a row on every call.
-- The cron deletes a row only after a long idle window (src/oauth.ts pruneUnusedClients): unused DCR
-- after refresh-TTL + 30 days; a client that ever got a refresh token is kept. Indexes are
-- for those NOT EXISTS checks, not a full scan of the other OAuth tables as DCR grows.
CREATE INDEX IF NOT EXISTS oauth_clients_created ON oauth_clients (created_at);
CREATE INDEX IF NOT EXISTS oauth_requests_client ON oauth_requests (client_id);
CREATE INDEX IF NOT EXISTS oauth_codes_client ON oauth_codes (client_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_client ON oauth_refresh_tokens (client_id);
