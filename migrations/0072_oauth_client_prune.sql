-- Unused OAuth clients (MCP dynamic registration): POST /oauth/register inserts a row on every call, and
-- oauth_clients had no retention. The cron deletes a row only when it is older than 30 days and nothing still
-- points at it (src/oauth.ts pruneUnusedClients). Indexes are for those NOT EXISTS checks, not a full scan of
-- the other OAuth tables as DCR grows.
CREATE INDEX IF NOT EXISTS oauth_clients_created ON oauth_clients (created_at);
CREATE INDEX IF NOT EXISTS oauth_requests_client ON oauth_requests (client_id);
CREATE INDEX IF NOT EXISTS oauth_codes_client ON oauth_codes (client_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_client ON oauth_refresh_tokens (client_id);
