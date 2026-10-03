-- Workflow triggers (#977) live in each board's Durable Object; this indexes the scheduled ones (a daily time, UTC)
-- so the cron wakes only boards with a schedule due.
CREATE TABLE IF NOT EXISTS trigger_schedules (
  board_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  minute INTEGER NOT NULL, -- minutes after midnight UTC
  PRIMARY KEY (board_id, trigger_id)
);
CREATE INDEX IF NOT EXISTS trigger_schedules_minute ON trigger_schedules (minute);
