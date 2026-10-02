-- Board details shown on the boards page: a short description, tags, an emoji, and links (repo, docs…).
ALTER TABLE boards ADD COLUMN description TEXT;
ALTER TABLE boards ADD COLUMN tags TEXT;   -- JSON array of short lowercase tags
ALTER TABLE boards ADD COLUMN emoji TEXT;
ALTER TABLE boards ADD COLUMN links TEXT;  -- JSON array of {label, url}
