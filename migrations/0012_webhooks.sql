-- Agent webhooks: a signed POST to your URL whenever something is addressed to your agent, so agents that don't
-- keep a connection open (hosted bots, serverless functions) can be woken up and answer through the JSON API.
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,          -- signs each delivery (shown once when created)
  created_at INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  last_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS webhooks_user ON webhooks (user);
