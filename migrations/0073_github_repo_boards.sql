-- Shared repo → board map (docs/github-app.md). Same table inbound notes read.
-- Never stores GitHub payloads, tokens, or private keys: only owner/name, the board id,
-- and an optional numeric App installation id.
CREATE TABLE IF NOT EXISTS github_repo_boards (
  repo TEXT PRIMARY KEY,   -- lowercase owner/name
  board_id TEXT NOT NULL,  -- b_…
  created_at INTEGER NOT NULL
);

-- Optional GitHub App installation id for this repository. Nullable; not a credential.
ALTER TABLE github_repo_boards ADD COLUMN installation_id INTEGER;

CREATE INDEX IF NOT EXISTS github_repo_boards_board ON github_repo_boards (board_id);
