-- Account log (#3490): one person's sign-ins and token changes, append-only, kept a year. Client and country only:
-- never an IP address or a token.
CREATE TABLE IF NOT EXISTS account_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  label TEXT,
  kind TEXT,
  client TEXT,
  country TEXT
);
-- The person's own log, newest first (and the JSONL download).
CREATE INDEX IF NOT EXISTS account_audit_user ON account_audit (user, id);
-- The yearly prune.
CREATE INDEX IF NOT EXISTS account_audit_at ON account_audit (at);
