-- Optional hosted charter.scope_paths: absolute directory prefixes for a room's file writes.
-- Advisory and per-machine; they do not enforce a remote sandbox. Local Gateway does not fetch them.
ALTER TABLE boards ADD COLUMN scope_paths TEXT; -- JSON array of absolute directories
