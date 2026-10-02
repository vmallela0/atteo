-- Archived boards are read-only and listed separately; restoring clears it.
ALTER TABLE boards ADD COLUMN archived_at INTEGER;
