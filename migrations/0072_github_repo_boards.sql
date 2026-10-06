-- Repo → board map for GitHub App inbound notes (docs/github-app.md). Empty until an operator
-- inserts a row or sets GITHUB_REPO_BOARDS. Never stores GitHub payloads — only owner/name → b_….
CREATE TABLE IF NOT EXISTS github_repo_boards (
  repo TEXT PRIMARY KEY,   -- lowercase owner/name
  board_id TEXT NOT NULL,  -- b_…
  created_at INTEGER NOT NULL
);
