-- One active terminal number match per approval. Replacing the row invalidates the old terminal token.
CREATE TABLE approval_terminal_confirms (
  approval_id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  token TEXT NOT NULL,
  code TEXT NOT NULL,
  choices TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX approval_terminal_user ON approval_terminal_confirms (user, status, expires_at);

-- The slow hash is the only persisted form of an optional approval PIN.
CREATE TABLE approval_pins (
  user TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  updated_at INTEGER NOT NULL
);
