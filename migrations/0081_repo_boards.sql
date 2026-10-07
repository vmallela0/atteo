-- A GitHub repository points to one board for each Atteo owner. The committed file names it; it grants no access.
CREATE TABLE repo_boards (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  board_id TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (owner, repo)
);
CREATE INDEX repo_boards_repo ON repo_boards (repo);

-- One open request per person and board. A declined request has a one-day cooldown.
CREATE TABLE repo_join_requests (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE UNIQUE INDEX repo_join_open ON repo_join_requests (board_id, requester) WHERE status = 'pending';
CREATE INDEX repo_join_owner ON repo_join_requests (board_id, status, created_at);
