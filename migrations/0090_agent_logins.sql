CREATE TABLE agent_logins (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  label TEXT NOT NULL,
  boards TEXT,
  email_alerts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  revoked_at INTEGER
);

CREATE INDEX agent_logins_user ON agent_logins(user, revoked_at, created_at);

CREATE TABLE agent_web_sessions (
  id_hash TEXT PRIMARY KEY,
  login_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (login_id) REFERENCES agent_logins(id) ON DELETE CASCADE
);

CREATE INDEX agent_web_sessions_login ON agent_web_sessions(login_id);
CREATE INDEX agent_web_sessions_expiry ON agent_web_sessions(expires_at);

-- Browser-only agents start the existing 10-minute device flow themselves. The browser that started it keeps the
-- device code in a strict /a cookie; the short user code is the only thing in the phone approval URL.
ALTER TABLE device_logins ADD COLUMN kind TEXT NOT NULL DEFAULT 'cli';
ALTER TABLE device_logins ADD COLUMN user_agent TEXT;
ALTER TABLE device_logins ADD COLUMN city TEXT;
ALTER TABLE device_logins ADD COLUMN country TEXT;
ALTER TABLE device_logins ADD COLUMN label TEXT;
ALTER TABLE device_logins ADD COLUMN boards TEXT;
ALTER TABLE device_logins ADD COLUMN agent_login_id TEXT;

-- One reservation per person makes count-only alert email batching atomic across simultaneous board deliveries.
CREATE TABLE agent_email_alerts (
  user TEXT PRIMARY KEY,
  last_sent_at INTEGER NOT NULL,
  last_notification_id INTEGER NOT NULL DEFAULT 0
);
