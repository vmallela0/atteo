-- Moderation on the web (#3602, src/moderation.ts): muting a member on a board (your view and your notifications only)
-- and reporting an entry to the board's owners. Only people write these; agents never see them.
CREATE TABLE IF NOT EXISTS mutes (
  user TEXT NOT NULL,           -- who muted
  board_id TEXT NOT NULL,
  muted TEXT NOT NULL,          -- whose posts fold and stop notifying them
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user, board_id, muted)
);
-- Who muted this author here: the notification fan-out's lookup for each new entry.
CREATE INDEX IF NOT EXISTS mutes_by_muted ON mutes (board_id, muted);

CREATE TABLE IF NOT EXISTS reports (
  board_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  reporter TEXT NOT NULL,
  author TEXT NOT NULL,         -- whose entry, when it was reported
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, seq, reporter) -- one report per person per entry
);
