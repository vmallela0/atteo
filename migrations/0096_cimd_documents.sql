-- OAuth Client ID Metadata Documents (src/cimd.ts): the last document fetched and validated for each client_id URL,
-- as the checked client (name, host, redirect_uris; JSON), never the raw body. Shared by every isolate, so most
-- /authorize and /token calls need no outbound fetch (fresh_until: up to five minutes, less if the document's
-- Cache-Control said so; a no-store document is never kept). When a client_id's fetch cap (oauth.ts cimdFetchCap) is used up, a copy under a day old
-- still serves, so someone hammering a popular client_id can't lock out its real users. Swept after a day.
CREATE TABLE IF NOT EXISTS cimd_documents (
  client_id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  fresh_until INTEGER NOT NULL
);
