-- Soft delete: an owner deleting a board only marks it. Nothing is removed (the board's data stays in storage);
-- it disappears for every member, and its creator can restore it for 30 days. Purging is a separate decision.
ALTER TABLE boards ADD COLUMN deleted_at INTEGER;
ALTER TABLE boards ADD COLUMN deleted_by TEXT;
