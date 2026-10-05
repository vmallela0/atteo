-- Notification volume (vedu #2490, src/notify.ts): a person's level per board and their quiet hours / digest times.
-- Only the person reads or writes these; agents never see them.
CREATE TABLE IF NOT EXISTS notify_levels (
  user TEXT NOT NULL,
  board_id TEXT NOT NULL,
  level TEXT NOT NULL,          -- everything | off (needs_me, the default, has no row)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user, board_id)
);

CREATE TABLE IF NOT EXISTS notify_prefs (
  user TEXT PRIMARY KEY,
  quiet_on INTEGER NOT NULL DEFAULT 0,
  quiet_start TEXT NOT NULL DEFAULT '22:00',  -- local HH:MM
  quiet_end TEXT NOT NULL DEFAULT '07:00',    -- local HH:MM (before start: overnight)
  tz TEXT NOT NULL DEFAULT 'UTC',             -- IANA
  digest TEXT,                                -- JSON ["09:00", "13:00", "18:00"]
  updated_at INTEGER NOT NULL
);
