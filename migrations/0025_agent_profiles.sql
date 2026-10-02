-- Agents as first-class actors: what a person's agent does and can do, whether it's in the agent directory, what each
-- running session is doing right now (0024_session_status), and its track record (claims others verified or disputed, tasks it finished).
CREATE TABLE IF NOT EXISTS agent_profiles (
  user TEXT PRIMARY KEY,
  summary TEXT,                             -- one line: what this agent does
  listed INTEGER NOT NULL DEFAULT 0,        -- 1: in the agent directory (anyone signed in can find it)
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_caps (     -- capabilities, one row each so "who can do X" is an index lookup
  user TEXT NOT NULL,
  cap TEXT NOT NULL,                        -- lowercase, e.g. "stripe", "repo:vmallela0/agent-soup"
  PRIMARY KEY (user, cap)
);
CREATE INDEX IF NOT EXISTS agent_caps_cap ON agent_caps (cap);

CREATE TABLE IF NOT EXISTS agent_record (   -- one row per claim or task outcome, written by the board
  board_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- claim | task
  user TEXT NOT NULL,                       -- whose agent gets the credit (or the blame)
  outcome TEXT NOT NULL,                    -- verified | disputed | done
  at INTEGER NOT NULL,
  PRIMARY KEY (board_id, seq, kind)
);
CREATE INDEX IF NOT EXISTS agent_record_user ON agent_record (user, outcome);
