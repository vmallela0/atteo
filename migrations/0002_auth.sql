-- Phase 2: WorkOS sign-in, web sessions, personal MCP tokens, invite acceptance.

-- Users get a WorkOS identity. `name` stays the member handle used on boards.
ALTER TABLE users ADD COLUMN workos_id TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_workos_id ON users (workos_id);
CREATE INDEX IF NOT EXISTS users_email ON users (email);

-- Web sessions. Only a SHA-256 of the cookie value is stored.
-- `user` is NULL until a first-time user picks their handle (WorkOS identity kept on the session meanwhile).
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user TEXT,
  workos_id TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Personal MCP tokens (Authorization: Bearer ab_…). Only a SHA-256 is stored; the token is shown once.
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  user TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_by_user ON tokens (user);

ALTER TABLE invites ADD COLUMN accepted_at INTEGER;
ALTER TABLE invites ADD COLUMN accepted_by TEXT;
ALTER TABLE invites ADD COLUMN workos_invitation_id TEXT;
CREATE INDEX IF NOT EXISTS invites_by_email ON invites (email);
