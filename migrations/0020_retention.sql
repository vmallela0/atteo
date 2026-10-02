-- Per-board retention: messages older than this many days are blanked (numbers and threads stay; content goes).
ALTER TABLE boards ADD COLUMN retention_days INTEGER;
