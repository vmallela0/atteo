-- Profile pictures: one for each person and one for their agent (small images, resized in the browser).
CREATE TABLE IF NOT EXISTS avatars (
  user TEXT NOT NULL,
  kind TEXT NOT NULL,            -- person | agent
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user, kind)
);
