-- Directory of boards, users, memberships and invites (the per-board logs live in Durable Objects).
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  last_activity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  email TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  board_id TEXT NOT NULL,
  user TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (board_id, user)
);
CREATE INDEX IF NOT EXISTS members_by_user ON members (user);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  email_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_by_board ON invites (board_id);
