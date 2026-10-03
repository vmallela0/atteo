-- Read aloud (POST /api/tts): characters each person sent to the voice provider per calendar month (UTC "YYYY-MM").
-- Cached replays aren't counted. The monthly budget lives in code (src/tts.ts, TTS_MONTHLY_CHARS overrides it).
CREATE TABLE IF NOT EXISTS tts_usage (
  user TEXT NOT NULL,
  month TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, month)
);
