-- Board charter: what the room is for, which data classes it may hold, and a short note per member.
-- How long messages stay is boards.retention_days, read and written with the charter.
ALTER TABLE boards ADD COLUMN goal TEXT;
ALTER TABLE boards ADD COLUMN data_classes TEXT; -- JSON array of short labels
ALTER TABLE boards ADD COLUMN member_notes TEXT; -- JSON object { user: note }
