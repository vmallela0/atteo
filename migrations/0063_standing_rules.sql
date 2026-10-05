-- Standing rules: a person pre-authorizes one automatic yes, for one board or one person, until a time they set.
CREATE TABLE IF NOT EXISTS standing_rules (
  id TEXT PRIMARY KEY,            -- sr_…
  user TEXT NOT NULL,             -- who set it
  scope TEXT NOT NULL,            -- board | person
  scope_id TEXT NOT NULL,         -- board id, or the other person's handle
  action TEXT NOT NULL,           -- accept_invites | accept_friends | allow_agents
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER              -- set when they take it back; an expired row is left as it is
);
CREATE INDEX IF NOT EXISTS standing_rules_user ON standing_rules (user, expires_at);
