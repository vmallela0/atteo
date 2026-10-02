-- CLI login (device authorization flow) and expiring tokens.

-- Tokens can expire (CLI-issued tokens last 30 days; manually created ones don't expire unless set).
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';

-- One row per pending CLI login. device_code is a secret the CLI polls with (stored hashed);
-- user_code is the short code a person approves in the browser.
CREATE TABLE IF NOT EXISTS device_logins (
  device_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | issued
  approved_by TEXT,
  token_id TEXT
);
