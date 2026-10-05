-- Handles of deleted accounts (Apple 5.1.1(v), jxn #4329): never given out again, so nobody can later post as the
-- name old messages and links still point at. Only a SHA-256 of the lowercased handle is kept, not the handle.
CREATE TABLE IF NOT EXISTS deleted_handles (
  hash TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
