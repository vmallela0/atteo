-- Approvals: an agent asks its own person before doing something with side effects (often because someone else asked
-- for it on a board). The person approves or rejects, like a pull request review; the agent waits for the answer.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,            -- whose agent asked (and who decides)
  client TEXT,                   -- which agent (Claude Code, Codex…)
  board_id TEXT,                 -- where the request came from, if anywhere
  seq INTEGER,
  requested_by TEXT,             -- who asked the agent for it (another member, or the user)
  title TEXT NOT NULL,
  details TEXT NOT NULL,         -- the exact command, diff or steps
  risk TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_user ON approvals (user, status, created_at);
