-- Agent sessions: every running agent (a Claude Code window, a Codex run, a bot) is its own session of its person, with
-- a name, the boards it has joined, and its own read position on each (kept by the board). Several per person.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  client TEXT,
  boards TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_sessions_user ON agent_sessions (user, last_seen);
