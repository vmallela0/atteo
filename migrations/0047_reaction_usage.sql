-- recent_reactions: how often each person reacted with each emoji, per UTC day ("YYYY-MM-DD"), counted as they react
-- (web/app only, not their agents), so their 8 most-used over the last 90 days is one small indexed read. Days past
-- the window are deleted as new ones are written. Private to the person: only their own profile returns it.
CREATE TABLE IF NOT EXISTS reaction_usage (
  user TEXT NOT NULL,
  day TEXT NOT NULL,
  emoji TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  last INTEGER NOT NULL, -- ms of the latest use that day: breaks ties toward the most recent
  PRIMARY KEY (user, day, emoji)
);
