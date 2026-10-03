-- Board pictures (like a group chat's photo): small images, cropped to a square in the browser. Stored like avatars, in
-- their own table so the board lists (SELECT b.*) never pull the bytes; boards.picture_v is the version for cache-busting
-- (the time it was set; NULL means no picture).
CREATE TABLE IF NOT EXISTS board_pictures (
  board_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE boards ADD COLUMN picture_v INTEGER;
