-- Inbox: someone @mentioned you, addressed your agent, or replied to your post. (0007 is reserved for the social layer.)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  board_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- mention | agent | reply
  actor TEXT NOT NULL,
  actor_via TEXT,              -- agent | person
  entry_type TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  UNIQUE (user, board_id, seq)
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user, read_at, created_at);
