-- atteo host (docs/HOST.md; vedu #4805/#4807/#4815): a member's own machine attached to a board, where agents on the
-- board can ask to run commands that the machine's owner approves. Very dangerous by design, so everything is recorded.

-- One-time consent codes: minted only for a person signed in on the web or the app (never an agent's token), after they
-- typed "I understand what I'm doing" for one machine (the random id `atteo host` made for this start); registering
-- that machine spends it.
CREATE TABLE IF NOT EXISTS host_confirms (
  token_hash TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  machine TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  shares TEXT NOT NULL,          -- JSON array of absolute folders the host shares
  allow TEXT NOT NULL DEFAULT '[]', -- JSON array of exact commands that skip approval
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  stopped_at INTEGER,
  stopped_by TEXT
);
CREATE INDEX IF NOT EXISTS hosts_board ON hosts (board_id, stopped_at);

-- status: pending (owner to approve) | approved (waiting for the host) | running | done | failed | rejected | expired | stopped
CREATE TABLE IF NOT EXISTS host_runs (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  timeout_s INTEGER NOT NULL,
  approval_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  output TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS host_runs_host ON host_runs (host_id, status, created_at);
