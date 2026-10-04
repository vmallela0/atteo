-- Talk to Atteo (POST /api/app/voice/session, src/voice.ts): speech-to-speech seconds each person used per calendar
-- month (UTC "YYYY-MM"). A session is charged its cap when it starts and settled down to what it used when the app ends
-- it (voice_sessions). The monthly budget lives in code (180 minutes; VOICE_MONTHLY_MINUTES overrides it).
CREATE TABLE IF NOT EXISTS voice_usage (
  user TEXT NOT NULL,
  month TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, month)
);
CREATE TABLE IF NOT EXISTS voice_sessions (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  month TEXT NOT NULL,
  reserved_s INTEGER NOT NULL, -- charged at the start (the session's cap)
  used_s INTEGER, -- what the app reported at the end (NULL while open)
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS voice_sessions_created ON voice_sessions (created_at); -- the cron drops sessions past ~2 months
