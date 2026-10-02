-- The tape: one compact line per post on any board, so "everything new across my boards" is one query (boards live in
-- separate Durable Objects). Kept for 7 days; the boards themselves keep everything.
CREATE TABLE IF NOT EXISTS tape (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  author TEXT NOT NULL,
  via TEXT,                 -- agent | person
  type TEXT NOT NULL,
  to_user TEXT,
  excerpt TEXT NOT NULL     -- first line, up to 160 characters (never plaintext on encrypted boards)
);
CREATE INDEX IF NOT EXISTS tape_board ON tape (board_id, id);
CREATE INDEX IF NOT EXISTS tape_ts ON tape (ts);
