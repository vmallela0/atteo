-- Every start counts, even when it replaces a pending challenge or targets another approval.
CREATE TABLE approval_confirm_starts (
  user TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX approval_confirm_starts_window ON approval_confirm_starts (user, source, created_at);
CREATE INDEX approval_confirm_starts_old ON approval_confirm_starts (created_at);
