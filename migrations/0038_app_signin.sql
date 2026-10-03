-- The app's own sign-in (email + 6-digit code, POST /api/app/signin/*).
-- rate_limits: fixed-window counters, one row per key (e.g. "start:ip:<ip>", "verify:email:<sha256>"); swept by the cron.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
-- app_signups: someone proved their email in the app but has no Atteo name yet. The app holds the ticket (only its
-- SHA-256 is stored) for a few minutes while they pick one; single use.
CREATE TABLE IF NOT EXISTS app_signups (
  ticket_hash TEXT PRIMARY KEY,
  workos_id TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  device_name TEXT,
  expires_at INTEGER NOT NULL
);
