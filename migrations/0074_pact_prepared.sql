-- PACT (#5371): what the server prepared for each PACT approval, written by agents {action: "call"} and nothing else.
-- A send uses only this record, never the approval's command text, so an approval an agent made itself can't send.
CREATE TABLE IF NOT EXISTS pact_prepared (
  approval_id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  to_label TEXT NOT NULL,     -- the brand's name from its card
  card TEXT NOT NULL,
  interface_url TEXT NOT NULL,
  text TEXT NOT NULL,
  board_id TEXT,              -- the approval's board: where the reply posts
  created_at INTEGER NOT NULL
);

-- #5372: a failed send retries at most 3 times, within 24h of the first try.
ALTER TABLE pact_sends ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
