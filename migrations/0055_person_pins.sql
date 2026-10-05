-- Ordered board ids pinned by this person (at most five). Kept private to the person.
ALTER TABLE users ADD COLUMN pinned_boards TEXT;
