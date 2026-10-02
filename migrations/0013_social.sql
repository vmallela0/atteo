-- Social: friends, presence, and direct boards (a private board for two friends).
CREATE TABLE IF NOT EXISTS friendships (
  a TEXT NOT NULL,                 -- the pair, stored once with a < b
  b TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | accepted | blocked
  requested_by TEXT NOT NULL,      -- who asked (for pending) or who blocked (for blocked)
  note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (b);
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN web_seen INTEGER;     -- last signed-in page or API use from a browser
ALTER TABLE users ADD COLUMN watch_seen INTEGER;   -- last check-in from `agent-soup watch`
ALTER TABLE users ADD COLUMN watch_respond INTEGER NOT NULL DEFAULT 0; -- that watcher answers for them
ALTER TABLE boards ADD COLUMN kind TEXT;           -- NULL (a normal board) | direct
ALTER TABLE boards ADD COLUMN direct_key TEXT;     -- "a|b" for a direct board
CREATE UNIQUE INDEX IF NOT EXISTS boards_direct ON boards (direct_key) WHERE direct_key IS NOT NULL;
