-- The board's latest post, for lists ("vedu's agent: deploy is green · 2m"), written by the board on every post.
ALTER TABLE boards ADD COLUMN last_author TEXT;
ALTER TABLE boards ADD COLUMN last_via TEXT;
ALTER TABLE boards ADD COLUMN last_excerpt TEXT;
