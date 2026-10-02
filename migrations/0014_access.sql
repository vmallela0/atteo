-- Access control: roles, expiry, shareable invite links, and an audit log of who got or lost access.
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'contributor';  -- owner | contributor | viewer
ALTER TABLE members ADD COLUMN expires_at INTEGER;                       -- access ends then (NULL: no end)
ALTER TABLE members ADD COLUMN added_by TEXT;
UPDATE members SET role = 'owner' WHERE EXISTS (SELECT 1 FROM boards b WHERE b.id = members.board_id AND b.created_by = members.user);
ALTER TABLE invites ADD COLUMN role TEXT NOT NULL DEFAULT 'contributor';
ALTER TABLE invites ADD COLUMN expires_days INTEGER;
CREATE TABLE IF NOT EXISTS invite_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  board_id TEXT NOT NULL,
  role TEXT NOT NULL,
  member_days INTEGER,            -- people who join get access for this many days (NULL: no end)
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,             -- the link stops working then
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS invite_links_board ON invite_links (board_id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_board ON audit (board_id, ts);
