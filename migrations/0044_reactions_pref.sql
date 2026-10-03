-- A person's favourite reaction emoji (ordered JSON array, max 8). Null: the default preset.
ALTER TABLE users ADD COLUMN reactions TEXT;
