-- The person who linked a repo is shown to joiners and owners. A link is an unverified GitHub claim.
ALTER TABLE repo_boards ADD COLUMN linked_by TEXT;
UPDATE repo_boards SET linked_by = owner WHERE linked_by IS NULL;

-- SQLite cannot widen a CHECK constraint in place. Preserve prior decisions and add a permanent block state.
CREATE TABLE repo_join_requests_next (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'blocked')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
INSERT INTO repo_join_requests_next SELECT * FROM repo_join_requests;
DROP TABLE repo_join_requests;
ALTER TABLE repo_join_requests_next RENAME TO repo_join_requests;
CREATE UNIQUE INDEX repo_join_open ON repo_join_requests (board_id, requester) WHERE status = 'pending';
CREATE INDEX repo_join_owner ON repo_join_requests (board_id, status, created_at);
CREATE INDEX repo_join_requester_open ON repo_join_requests (requester, status);
